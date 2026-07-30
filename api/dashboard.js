const {
  supabase, cors, num, ds,
  mapProduct, mapSR, mapTx, mapPayment, mapDmg, mapBonus,
  mapRoad, mapRoadPlan, mapRoadWeeklyPlan, bdtToday, bdtYesterday, weekdayOf,
  safeErr, fetchAll, cyclePeriodForDate, cyclePeriodBounds
} = require('./_lib/db');

// V41 update 7 — every "this month" figure on the dashboard is scoped to
// the company pay cycle (26th of previous month → 25th of current month),
// not the plain calendar month. See cyclePeriodBounds in _lib/db.js.
function _cycleMonthStart(todayStr) {
  return cyclePeriodBounds(cyclePeriodForDate(todayStr)).start;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { role, userId, action } = req.query;

    // ══════════════════════════════════════════════════════
    //  APP-BOOT LOAD-ALL — merged in from the old load-all.js
    //  (AXIION Blueprint §3 — load-all.js folded into dashboard.js)
    // ══════════════════════════════════════════════════════
    if (action === 'load-all') {
      const [pRes, sRes, rRes] = await Promise.all([
        supabase.from('products').select('*').order('sort_order').order('created_at'),
        supabase.from('srs').select('*').order('created_at'),
        supabase.from('roads').select('*').order('created_at')
      ]);
      const products = (pRes.data || []).map(mapProduct);
      const srsAll   = (sRes.data || []).map(mapSR);
      const roads    = (rRes.data || []).map(mapRoad);
      // V40: stock comes straight from products.current_stock (kept in
      // sync by a DB trigger on every transaction insert) instead of
      // re-fetching + re-summing the ENTIRE lifetime transactions table
      // on every app boot — that old pattern got linearly more expensive
      // in Supabase egress as the table grew year over year. See
      // migration_v40_stock_balance.sql.
      const stockMap = {};
      products.forEach(p => { stockMap[p.id] = p.currentStock; });
      return res.json({ ok: true, products, srs: srsAll, roads, stockMap });
    }

    // ══════════════════════════════════════════════════════
    //  SO DASHBOARD — isolated to SO's own data + assigned DSRs
    // ══════════════════════════════════════════════════════
    if (role === 'so' && userId) {
      const today = new Date().toISOString().slice(0, 10);
      const monthStart = _cycleMonthStart(today);
      // Optional custom date-range for full sales visibility (AXIION §17)
      const rangeFrom = req.query.from || '';
      const rangeTo   = req.query.to   || '';

      // Assigned DSRs for this SO
      const { data: dsrsData } = await supabase.from('srs').select('*').eq('so_id', userId).order('created_at');
      const assignedDsrs = (dsrsData || []).map(mapSR);
      const dsrIds = assignedDsrs.map(d => d.id);
      // All IDs: SO + their DSRs
      const allIds = [userId, ...dsrIds];

      // Products & stock (read-only, all products visible to SO)
      // V40: stock read straight from products.current_stock — see
      // migration_v40_stock_balance.sql — no more full transaction
      // history refetch on every SO dashboard load.
      const { data: prodData } = await supabase.from('products').select('*').order('sort_order').order('created_at');
      const products = (prodData || []).map(mapProduct);
      const stockMap = {};
      products.forEach(p => { stockMap[p.id] = p.currentStock; });

      // Transactions: SO + DSRs, today and this month
      let txTodayQ = supabase.from('transactions').select('*').eq('date', today).order('created_at');
      let txMonthQ = supabase.from('transactions').select('*').gte('date', monthStart).lte('date', today).order('created_at');
      if (allIds.length) {
        txTodayQ = txTodayQ.in('sr_id', allIds);
        txMonthQ = txMonthQ.in('sr_id', allIds);
      }

      // Custom range query — only fired when both from/to are supplied
      let txRangeQ = null;
      if (allIds.length && rangeFrom && rangeTo) {
        txRangeQ = supabase.from('transactions').select('*')
          .gte('date', rangeFrom).lte('date', rangeTo).in('sr_id', allIds).order('created_at');
      }

      // All-time for due calculation (give/return/damage for DSRs only) —
      // this is a lifetime aggregate, so it MUST be paginated (fetchAll),
      // never a bare query, or dues silently go wrong past 1000 rows.
      const [txTodayRes, txMonthRes, txAllDue, txRangeRes] = await Promise.all([
        allIds.length ? txTodayQ : { data: [] },
        allIds.length ? txMonthQ : { data: [] },
        dsrIds.length
          ? fetchAll(() => supabase.from('transactions').select('type,sr_id,total_units,total_revenue').in('type', ['give', 'return', 'damage']).in('sr_id', dsrIds).order('created_at'))
          : [],
        txRangeQ ? txRangeQ : { data: [] }
      ]);

      const txToday = (txTodayRes.data || []).map(mapTx);
      const txMonth = (txMonthRes.data || []).map(mapTx);
      const txRange  = (txRangeRes.data || []).map(mapTx);

      // ── Full sales visibility, split regular (DSR-given) vs SO's own
      //    point-sale, for any date range (AXIION §17) ──────────────
      function buildSalesSplit(txList) {
        const regular = txList.filter(r => dsrIds.indexOf(r.srId) !== -1 && (r.type === 'give' || r.type === 'return'));
        const point   = txList.filter(r => r.srId === userId && (r.type === 'point_sale' || r.type === 'point_damage_return'));
        const regularRevenue = regular.filter(r => r.type === 'give').reduce((s, r) => s + num(r.totalRevenue), 0)
                              - regular.filter(r => r.type === 'return').reduce((s, r) => s + num(r.totalRevenue), 0);
        const pointRevenue   = point.filter(r => r.type === 'point_sale').reduce((s, r) => s + num(r.totalRevenue), 0)
                              - point.filter(r => r.type === 'point_damage_return').reduce((s, r) => s + num(r.totalRevenue), 0);
        const regularUnits   = regular.filter(r => r.type === 'give').reduce((s, r) => s + num(r.totalUnits), 0)
                              - regular.filter(r => r.type === 'return').reduce((s, r) => s + num(r.totalUnits), 0);
        const pointUnits     = point.filter(r => r.type === 'point_sale').reduce((s, r) => s + num(r.totalUnits), 0)
                              - point.filter(r => r.type === 'point_damage_return').reduce((s, r) => s + num(r.totalUnits), 0);
        return { regularRevenue, pointRevenue, regularUnits, pointUnits, totalRevenue: regularRevenue + pointRevenue };
      }
      const todaySplit = buildSalesSplit(txToday);
      const monthSplit = buildSalesSplit(txMonth);
      const rangeSplit = (rangeFrom && rangeTo) ? { from: rangeFrom, to: rangeTo, ...buildSalesSplit(txRange) } : null;

      // SO's own payments
      const { data: soPayData } = await supabase.from('sr_payments').select('*').eq('sr_id', userId).order('date', { ascending: false });
      const soPayments = (soPayData || []).map(mapPayment);
      const soTotalPaid = soPayments.reduce((s, r) => s + num(r.amount), 0);

      // DSR payments (all time, for due calc)
      let dsrPayData = { data: [] };
      if (dsrIds.length) {
        dsrPayData = await supabase.from('sr_payments').select('sr_id,amount').in('sr_id', dsrIds);
      }
      const dsrPayments = dsrPayData.data || [];

      // DSR month payments
      let dsrPayMonthData = { data: [] };
      if (dsrIds.length) {
        dsrPayMonthData = await supabase.from('sr_payments').select('*')
          .in('sr_id', dsrIds).gte('date', monthStart).lte('date', today).order('date');
      }
      const dsrPayMonth = (dsrPayMonthData.data || []).map(mapPayment);

      // SO own stats (point_sale only — direct sales by SO)
      const soTxToday = txToday.filter(r => r.srId === userId);
      const soTxMonth = txMonth.filter(r => r.srId === userId);
      const soOwnGivenRev  = txAllDue.filter(r => r.sr_id === userId && r.type === 'give').reduce((s, r) => s + num(r.total_revenue), 0);
      const soOwnReturnRev = txAllDue.filter(r => r.sr_id === userId && r.type === 'return').reduce((s, r) => s + num(r.total_revenue), 0);
      const soOwnDue = (soOwnGivenRev - soOwnReturnRev) - soTotalPaid;

      // DSR due map
      const dueMap = {};
      assignedDsrs.forEach(dsr => {
        dueMap[dsr.id] = { srId: dsr.id, name: dsr.name, area: dsr.area || '', phone: dsr.phone || '', thumb: dsr.thumb || '', givenRev: 0, returnRev: 0, payments: 0 };
      });
      txAllDue.forEach(r => {
        const sid = String(r.sr_id || ''); if (!sid || !dueMap[sid]) return;
        const rev = num(r.total_revenue);
        if (r.type === 'give')   dueMap[sid].givenRev  += rev;
        if (r.type === 'return') dueMap[sid].returnRev += rev;
      });
      dsrPayments.forEach(r => {
        const sid = String(r.sr_id || ''); if (!sid || !dueMap[sid]) return;
        dueMap[sid].payments += num(r.amount);
      });
      const dsrDueList = Object.values(dueMap).map(d => ({ ...d, due: (d.givenRev - d.returnRev) - d.payments }));
      const totalDsrDue = dsrDueList.reduce((s, d) => s + (d.due > 0 ? d.due : 0), 0);

      // Today stats (SO + DSRs combined)
      const todayGiven  = txToday.filter(r => r.type === 'give' || r.type === 'point_sale').reduce((s, r) => s + num(r.totalRevenue), 0);
      const todayReturn = txToday.filter(r => r.type === 'return' || r.type === 'point_damage_return').reduce((s, r) => s + num(r.totalRevenue), 0);
      // V44 #31 — "আজকের বিক্রয়" summary cards: damage cost reported
      // today across the SO + their assigned DSRs (uses purchase-price
      // based total_cost, same figure the damage/claims screens use).
      const todayDamage = txToday.filter(r => r.type === 'damage').reduce((s, r) => s + num(r.totalCost), 0);
      const monthGiven  = txMonth.filter(r => r.type === 'give' || r.type === 'point_sale').reduce((s, r) => s + num(r.totalRevenue), 0);
      const monthReturn = txMonth.filter(r => r.type === 'return' || r.type === 'point_damage_return').reduce((s, r) => s + num(r.totalRevenue), 0);
      const monthDsrPay = dsrPayMonth.reduce((s, r) => s + num(r.amount), 0);

      // V56 §4 — "you're due at [road] today" (day 1: SO visits), now
      // resolved LIVE from the weekly recurring rule instead of a
      // pre-inserted date row: does today's weekday match a rule for a
      // road assigned to me, and has that rule been active since on/
      // before today (active_from <= today)?
      const todayStr = bdtToday();
      const { data: roadDutyRows } = await supabase.from('road_weekly_plans')
        .select('*').eq('so_id', userId).eq('weekday', weekdayOf(todayStr)).lte('active_from', todayStr);
      const roadDuty = (roadDutyRows || []).map(mapRoadWeeklyPlan);

      // ── V55 #56 / V57 — "আজকের মোট বিক্রয়" (Today's Total Sale) widget ──
      // Pieces sold today by this SO's assigned DSRs (give − return), PLUS
      // any point-sale attributed to this SO (the SO's own counter sale, or
      // an Owner/Manager point-sale where this SO was picked as the seller
      // — V57 point-sale SO-select), minus point-sale damage returns. The
      // raw total is then reduced by that day's *bonus* pieces earned per
      // product — the buy-X-get-Y free units the Owner set on the product
      // (bonus_free_units / bonus_cases_req / case_size) — using the same
      // case-math as computeBonusRangeSummary in _lib/db.js, scoped to
      // today only. So the number shown here is the NET real sale
      // (freebie giveaway pieces excluded), not the gross pieces moved.
      // Only the net figure is returned (V57 — no separate gross field).
      const productThumbMap = {}, productNameMap = {}, productBonusMap = {};
      products.forEach(p => {
        productThumbMap[p.id] = p.thumb || '';
        productNameMap[p.id] = p.name || '';
        productBonusMap[p.id] = {
          caseSize: num(p.caseSize) || 1,
          bonusCasesReq: num(p.bonusCasesReq) || 1,
          bonusFreeUnits: num(p.bonusFreeUnits) || 0
        };
      });
      const todayProdMap = {};
      txToday.forEach(r => {
        const isDsrLeg  = dsrIds.indexOf(r.srId) !== -1 && (r.type === 'give' || r.type === 'return');
        const isSoPoint = r.srId === userId && (r.type === 'point_sale' || r.type === 'point_damage_return');
        if (!isDsrLeg && !isSoPoint) return;
        const pid = r.productId; if (!pid) return;
        if (!todayProdMap[pid]) {
          todayProdMap[pid] = {
            productId: pid,
            productName: r.productName || productNameMap[pid] || '',
            thumb: productThumbMap[pid] || '',
            sold: 0
          };
        }
        const units = num(r.totalUnits);
        const isPositive = (r.type === 'give' || r.type === 'point_sale');
        todayProdMap[pid].sold += (isPositive ? units : -units);
      });
      // Reduce each product's raw today-total by that day's earned bonus
      // pieces (same floor-division formula used everywhere else bonus is
      // calculated); only the net number goes to the client as `sold`.
      const todayProductSales = Object.values(todayProdMap)
        .map(p => {
          const raw = p.sold;
          const bp = productBonusMap[p.productId] || { caseSize: 1, bonusCasesReq: 1, bonusFreeUnits: 0 };
          const cases = Math.floor(raw / bp.caseSize);
          const bonusPieces = Math.floor(cases / bp.bonusCasesReq) * bp.bonusFreeUnits;
          return { productId: p.productId, productName: p.productName, thumb: p.thumb, sold: raw - bonusPieces };
        })
        .filter(p => p.sold > 0)
        .sort((a, b) => b.sold - a.sold);

      return res.json({
        ok: true,
        assignedDsrs,
        dsrDues: { total: totalDsrDue, list: dsrDueList },
        soPayments: soPayments.slice(0, 30),
        soOwnDue,
        products,
        stockMap,
        todayProductSales,
        // V44 #31 — `saleGross` (before returns), `damage`, `returns` are
        // the three "আজকের বিক্রয়" card figures; `revenue` (net) is kept
        // unchanged for everything else already reading it.
        today: { revenue: todayGiven - todayReturn, saleGross: todayGiven, damage: todayDamage, returns: todayReturn, split: todaySplit },
        month: { revenue: monthGiven - monthReturn, dsrPayments: monthDsrPay, split: monthSplit },
        range: rangeSplit,
        roadDuty
      });
    }

    // ══════════════════════════════════════════════════════
    //  DSR DASHBOARD — strictly isolated to own data
    // ══════════════════════════════════════════════════════
    if (role === 'dsr' && userId) {
      const today = new Date().toISOString().slice(0, 10);
      const monthStart = _cycleMonthStart(today);

      // V40: stock read straight from products.current_stock — see
      // migration_v40_stock_balance.sql — no more full transaction
      // history refetch on every DSR dashboard load. The lifetime
      // txAll fetch below is still needed (and still paginated) — it's
      // scoped to just this one DSR's own history for their own due
      // calculation, which is much smaller than the whole table.
      const [prodRes, txAll, paymentsRes, txMonthRes, payMonthRes] = await Promise.all([
        supabase.from('products').select('*').order('sort_order').order('created_at'),
        // Lifetime due for one DSR — still needs pagination for long-running,
        // high-volume DSRs (a few years of daily deliveries can pass 1000 rows).
        fetchAll(() => supabase.from('transactions').select('type,total_units,total_revenue').eq('sr_id', userId).in('type', ['give', 'return', 'damage']).order('created_at')),
        supabase.from('sr_payments').select('*').eq('sr_id', userId).order('date', { ascending: false }),
        supabase.from('transactions').select('*').eq('sr_id', userId).gte('date', monthStart).lte('date', today).order('created_at'),
        supabase.from('sr_payments').select('*').eq('sr_id', userId).gte('date', monthStart).lte('date', today).order('date')
      ]);

      const products = (prodRes.data || []).map(mapProduct);
      const stockMap = {};
      products.forEach(p => { stockMap[p.id] = p.currentStock; });
      const payments = (paymentsRes.data || []).map(mapPayment);
      const txMonth  = (txMonthRes.data || []).map(mapTx);
      const payMonth = (payMonthRes.data || []).map(mapPayment);

      // Own due calculation
      const givenRev  = txAll.filter(r => r.type === 'give').reduce((s, r)  => s + num(r.total_revenue), 0);
      const returnRev = txAll.filter(r => r.type === 'return').reduce((s, r) => s + num(r.total_revenue), 0);
      const totalPaid = payments.reduce((s, r) => s + num(r.amount), 0);
      const ownDue    = (givenRev - returnRev) - totalPaid;

      // Month summary
      const mGiven   = txMonth.filter(r => r.type === 'give' || r.type === 'point_sale').reduce((s, r)   => s + num(r.totalRevenue), 0);
      const mReturn  = txMonth.filter(r => r.type === 'return' || r.type === 'point_damage_return').reduce((s, r) => s + num(r.totalRevenue), 0);
      const mGivenU  = txMonth.filter(r => r.type === 'give').reduce((s, r) => s + num(r.totalUnits), 0);
      const mReturnU = txMonth.filter(r => r.type === 'return').reduce((s, r) => s + num(r.totalUnits), 0);
      const mPayAmt  = payMonth.reduce((s, r) => s + num(r.amount), 0);

      // ── V31 reconcile — today's given vs. sold-to-shops vs. still on
      //    van, plus cash actually collected today from shop sales. Pure
      //    visibility: does NOT feed into ownDue (see shops.js visit-sale
      //    comment for why 'dsr_sale' never touches stock or due itself).
      const dsrSaleToday    = txMonth.filter(r => r.type === 'dsr_sale' && r.date === today).reduce((s, r) => s + num(r.totalRevenue), 0);
      const givenTodayRev   = txMonth.filter(r => r.type === 'give'     && r.date === today).reduce((s, r) => s + num(r.totalRevenue), 0);
      const returnTodayRev  = txMonth.filter(r => r.type === 'return'   && r.date === today).reduce((s, r) => s + num(r.totalRevenue), 0);
      const damageTodayCost = txMonth.filter(r => r.type === 'damage'   && r.date === today).reduce((s, r) => s + num(r.totalCost), 0);
      const { data: shopDueTodayData } = await supabase.from('due_calendar')
        .select('amount,paid_amount').eq('dsr_id', userId).eq('client_type', 'shop').eq('due_date', today);
      const shopDueToday        = shopDueTodayData || [];
      const cashCollectedToday  = shopDueToday.reduce((s, r) => s + num(r.paid_amount), 0);
      const shopDueCreatedToday = shopDueToday.reduce((s, r) => s + (num(r.amount) - num(r.paid_amount)), 0);
      const stillWithDsrToday   = givenTodayRev - returnTodayRev - damageTodayCost - dsrSaleToday;

      // V56 §4 — "you're due at [road] today" (day 2: paired DSR
      // delivers, always the day AFTER the SO's visit — unchanged rule).
      // Resolved LIVE: did YESTERDAY's weekday match a rule for a road
      // this DSR is paired to, and was that rule active by yesterday?
      const yesterdayStr = bdtYesterday();
      const { data: roadDutyRows } = await supabase.from('road_weekly_plans')
        .select('*').eq('dsr_id', userId).eq('weekday', weekdayOf(yesterdayStr)).lte('active_from', yesterdayStr);
      const roadDuty = (roadDutyRows || []).map(mapRoadWeeklyPlan);

      return res.json({
        ok: true,
        products,
        stockMap,
        ownDue,
        givenRev,
        returnRev,
        totalPaid,
        payments: payments.slice(0, 30),
        month: { revenue: mGiven - mReturn, givenUnits: mGivenU, returnUnits: mReturnU, payments: mPayAmt },
        txMonth: txMonth.slice(0, 60),
        reconcile: {
          givenTodayRev, returnTodayRev, damageTodayCost, soldToShopsToday: dsrSaleToday,
          cashCollectedToday, shopDueCreatedToday, stillWithDsrToday
        },
        roadDuty
      });
    }

    // ══════════════════════════════════════════════════════
    //  OWNER / MANAGER DASHBOARD — full data
    // ══════════════════════════════════════════════════════
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = _cycleMonthStart(today);

    // V40: the old 'txAll' full-lifetime-transactions fetch below used
    // to serve TWO purposes at once — computing the stock map, and
    // feeding the bonus "units given since last cleared" calc further
    // down. Stock now comes straight from products.current_stock (kept
    // in sync by a DB trigger — see migration_v40_stock_balance.sql),
    // so we only still need the full-history fetch for the bonus calc,
    // which genuinely does need lifetime data (it looks back to each
    // product's own last-cleared date, which can be any date in the
    // past). This alone removes the single most expensive, most
    // frequently-repeated full-table fetch in the whole app.
    const [pRes, sRes, txTodayRes, txMonthRes, txAllForBonus, payMonthRes, dmgRes, bonRes] = await Promise.all([
      supabase.from('products').select('*').order('sort_order').order('created_at'),
      supabase.from('srs').select('*').order('created_at'),
      supabase.from('transactions').select('*').eq('date', today).order('created_at'),
      supabase.from('transactions').select('*').gte('date', monthStart).lte('date', today).order('created_at'),
      fetchAll(() => supabase.from('transactions').select('tx_id,type,product_id,total_units,date').eq('type', 'give').order('created_at')),
      supabase.from('sr_payments').select('*').gte('date', monthStart).lte('date', today).order('date'),
      supabase.from('dmg_claims').select('*').eq('status', 'pending').order('created_at'),
      supabase.from('bonus').select('*').order('created_at')
    ]);

    const products    = (pRes.data  || []).map(mapProduct);
    const srs         = (sRes.data  || []).map(mapSR);
    const txToday     = (txTodayRes.data  || []).map(mapTx);
    const txMonth     = (txMonthRes.data  || []).map(mapTx);
    const txAll       = txAllForBonus; // kept name for the bonus calc below, unchanged from here on
    const payMonth    = (payMonthRes.data || []).map(mapPayment);
    const dmgPending  = (dmgRes.data      || []).map(mapDmg);
    const bonusRecs   = (bonRes.data      || []).map(mapBonus);

    // ── Stock map — straight from products.current_stock, no full
    //    transaction history refetch needed any more ────────────────
    const stockMap = {};
    products.forEach(p => { stockMap[p.id] = p.currentStock; });

    // ── TODAY stats ────────────────────────────────────────
    const gU  = txToday.filter(r=>r.type==='give'||r.type==='point_sale').reduce((s,r)=>s+num(r.totalUnits),0);
    const rtU = txToday.filter(r=>r.type==='return'||r.type==='point_damage_return').reduce((s,r)=>s+num(r.totalUnits),0);
    const gR  = txToday.filter(r=>r.type==='give'||r.type==='point_sale').reduce((s,r)=>s+num(r.totalRevenue),0);
    const rtR = txToday.filter(r=>r.type==='return'||r.type==='point_damage_return').reduce((s,r)=>s+num(r.totalRevenue),0);
    const gC  = txToday.filter(r=>r.type==='give'||r.type==='point_sale').reduce((s,r)=>s+num(r.totalCost),0);
    const rtC = txToday.filter(r=>r.type==='return'||r.type==='point_damage_return').reduce((s,r)=>s+num(r.totalCost),0);
    const todayRevenue = gR - rtR;
    const todayProfit  = todayRevenue - (gC - rtC);

    // ── MONTH stats ────────────────────────────────────────
    const mgR  = txMonth.filter(r=>r.type==='give'||r.type==='point_sale').reduce((s,r)=>s+num(r.totalRevenue),0);
    const mrtR = txMonth.filter(r=>r.type==='return'||r.type==='point_damage_return').reduce((s,r)=>s+num(r.totalRevenue),0);
    const mgC  = txMonth.filter(r=>r.type==='give'||r.type==='point_sale').reduce((s,r)=>s+num(r.totalCost),0);
    const mrtC = txMonth.filter(r=>r.type==='return'||r.type==='point_damage_return').reduce((s,r)=>s+num(r.totalCost),0);
    const monthRevenue = mgR - mrtR;
    const monthProfit  = monthRevenue - (mgC - mrtC);
    const monthPayments = payMonth.reduce((s,r)=>s+num(r.amount),0);

    // ── STOCK list ─────────────────────────────────────────
    const stockList = products.map(p => {
      const units = stockMap[p.id] || 0;
      return {
        id: p.id, name: p.name, sku: p.sku,
        caseSize: num(p.caseSize) || 1,
        unitType: p.unitType || 'কেস',
        lowStockAlert: num(p.lowStockAlert),
        thumb: p.thumb || '',
        units,
        sellValue: units * num(p.sellingPrice)
      };
    });
    const totalSell = stockList.reduce((s,p)=>s+p.sellValue,0);

    // ── DUES (SR-wise) ─────────────────────────────────────
    const srDueMap = {};
    srs.forEach(sr => {
      srDueMap[sr.id] = {
        srId: sr.id, name: sr.name, area: sr.area,
        phone: sr.phone, thumb: sr.thumb || '',
        givenUnits: 0, returnUnits: 0,
        givenRev: 0, returnRev: 0, payments: 0
      };
    });

    const [txAllForDues, payAll] = await Promise.all([
      fetchAll(() => supabase.from('transactions').select('type,sr_id,total_units,total_revenue').in('type',['give','return','damage']).order('created_at')),
      fetchAll(() => supabase.from('sr_payments').select('sr_id,amount').order('date'))
    ]);

    (txAllForDues || []).forEach(r => {
      const sid = String(r.sr_id || ''); if (!sid) return;
      if (!srDueMap[sid]) srDueMap[sid] = { srId:sid, name:r.sr_name||'', area:'', phone:'', thumb:'', givenUnits:0, returnUnits:0, givenRev:0, returnRev:0, payments:0 };
      const u = num(r.total_units), rev = num(r.total_revenue);
      if (r.type==='give')   { srDueMap[sid].givenUnits += u; srDueMap[sid].givenRev += rev; }
      if (r.type==='return') { srDueMap[sid].returnUnits+= u; srDueMap[sid].returnRev+= rev; }
    });
    (payAll || []).forEach(r => {
      const sid = String(r.sr_id || ''); if (!sid) return;
      if (srDueMap[sid]) srDueMap[sid].payments += num(r.amount);
    });

    const duesList = Object.values(srDueMap).map(sr => ({
      ...sr,
      due: (sr.givenRev - sr.returnRev) - sr.payments
    }));
    const totalDue = duesList.reduce((s,sr)=>s+(sr.due>0?sr.due:0),0);

    // ── TODAY'S NEW DUE — same formula, filtered to today (AXIION §6) ──
    const todayGivenRev  = txToday.filter(r=>r.type==='give').reduce((s,r)=>s+num(r.totalRevenue),0);
    const todayReturnRev = txToday.filter(r=>r.type==='return').reduce((s,r)=>s+num(r.totalRevenue),0);
    const todayPayAmt    = payMonth.filter(r=>r.date===today).reduce((s,r)=>s+num(r.amount),0);
    const todayNewDue    = (todayGivenRev - todayReturnRev) - todayPayAmt;

    // ── DAMAGE pending ─────────────────────────────────────
    const dmgPendingAmt = dmgPending.reduce((s,r)=>s+num(r.totalCost),0);

    // ── BONUS pending ──────────────────────────────────────
    let bonusPendingAmt = 0;
    products.filter(p=>num(p.bonusFreeUnits)>0||num(p.bonusFreeMoney)>0).forEach(p => {
      const cleared = bonusRecs.filter(b=>String(b.productId)===String(p.id)&&b.status==='cleared'&&b.clearedDate)
        .sort((a,b)=>String(b.clearedDate).localeCompare(String(a.clearedDate)));
      const lastCleared = cleared.length>0?String(cleared[0].clearedDate):'';
      const fromDate = lastCleared||'2000-01-01';
      const txSince = txAll.filter(r=>String(r.product_id)===String(p.id)&&r.type==='give'&&ds(r.date)>fromDate);
      const totalGiven = txSince.reduce((s,r)=>s+num(r.total_units),0);
      const cs = num(p.caseSize)||1, bcr = num(p.bonusCasesReq)||1;
      const totalCases = Math.floor(totalGiven/cs);
      const accUnits = Math.floor(totalCases/bcr)*num(p.bonusFreeUnits);
      const accMoney = Math.floor(totalCases/bcr)*num(p.bonusFreeMoney||0);
      const accAmount = accUnits*num(p.purchasePrice)+accMoney;
      const totalRec = bonusRecs.filter(b=>String(b.productId)===String(p.id)&&b.status==='cleared').reduce((s,b)=>s+num(b.bonusAmount),0);
      bonusPendingAmt += Math.max(0, accAmount - totalRec);
    });

    // ── TOTAL STOCK VALUES ─────────────────────────────────
    // (Update #48 — the old "Recent Transactions" widget and its backing
    // query were removed entirely from the Owner/Manager dashboard.)
    const totalBuyValue  = stockList.reduce((s,p)=>s+(p.units*(products.find(pr=>pr.id===p.id)?num(products.find(pr=>pr.id===p.id).purchasePrice):0)),0);
    const totalSellValue = totalSell;
    const estimatedProfit = totalSellValue - totalBuyValue;

    // ── LOW STOCK ──────────────────────────────────────────
    const lowStockList = stockList.filter(p=>num(p.lowStockAlert)>0&&p.units<=num(p.lowStockAlert));

    // ── FULL RANKED SKU LIST — Today & Month, ranked in CASES ───────
    //    (Update #47 — replaced the old "Top 4 Products" widget, which
    //    hid every SKU past 4th place. Now returns EVERY product that
    //    exists, ranked #1 (best-selling) down to the lowest — including
    //    SKUs with zero sales that day/month, so the owner sees the
    //    complete picture, not just the winners. Ranking + case-
    //    conversion math is unchanged from the old buildTopSellers.)
    function buildRankedSellers(txList) {
      const sales = {};
      products.forEach(p => { sales[p.id] = { productId: p.id, productName: p.name, units: 0 }; });
      txList.forEach(r => {
        const pid = String(r.productId || ''); if (!pid) return;
        if (!sales[pid]) sales[pid] = { productId: pid, productName: r.productName || '', units: 0 };
        if (r.type === 'give' || r.type === 'point_sale') sales[pid].units += num(r.totalUnits);
        if (r.type === 'return' || r.type === 'point_damage_return') sales[pid].units -= num(r.totalUnits);
      });
      return Object.values(sales).sort((a, b) => b.units - a.units)
        .map((p, i) => {
          const prod = products.find(pr => pr.id === p.productId) || {};
          const cs = num(prod.caseSize) || 1;
          const exactCases = p.units / cs;
          return {
            rank: i + 1,
            productId: p.productId,
            productName: p.productName,
            units: p.units,
            caseSize: cs,
            unitType: prod.unitType || 'কেস',
            cases: Math.round(exactCases),          // whole-case ranking figure
            exactCases: +exactCases.toFixed(4),      // precise value, shown on tap
            thumb: (stockList.find(s => s.id === p.productId) || {}).thumb || ''
          };
        });
    }
    const rankedToday = buildRankedSellers(txToday);
    const rankedMonth = buildRankedSellers(txMonth);

    // ── SR PERFORMANCE (this month) ────────────────────────
    const srPerf = {};
    srs.forEach(sr=>{ srPerf[sr.id]={srId:sr.id,name:sr.name,area:sr.area||'',thumb:sr.thumb||'',soldUnits:0,returnUnits:0,revenue:0,due:0}; });
    txMonth.forEach(r=>{
      const sid=String(r.srId||''); if(!sid) return;
      if(!srPerf[sid]) srPerf[sid]={srId:sid,name:r.srName||'',area:'',thumb:'',soldUnits:0,returnUnits:0,revenue:0,due:0};
      if(r.type==='give'){srPerf[sid].soldUnits+=num(r.totalUnits);srPerf[sid].revenue+=num(r.totalRevenue);}
      if(r.type==='return'){srPerf[sid].returnUnits+=num(r.totalUnits);srPerf[sid].revenue-=num(r.totalRevenue);}
    });
    duesList.forEach(d=>{ if(srPerf[d.srId]) srPerf[d.srId].due=d.due; });
    const srPerfList = Object.values(srPerf).filter(s=>s.soldUnits>0||s.returnUnits>0).sort((a,b)=>b.revenue-a.revenue);

    res.json({
      ok: true,
      today: { revenue: todayRevenue, profit: todayProfit, givenUnits: gU, returnUnits: rtU },
      month: { revenue: monthRevenue, profit: monthProfit, payments: monthPayments },
      stock: { list: stockList, totalSell, totalBuyValue, totalSellValue, estimatedProfit },
      dues:  { total: totalDue, todayNew: todayNewDue, list: duesList },
      damage: { pendingAmt: dmgPendingAmt },
      bonus:  { pendingAmt: bonusPendingAmt },
      lowStock: lowStockList,
      rankedToday,
      rankedMonth,
      srPerformance: srPerfList
    });

  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
