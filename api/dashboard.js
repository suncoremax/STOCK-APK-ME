const {
  supabase, cors, num, ds,
  mapProduct, mapSR, mapTx, mapPayment, mapDmg, mapBonus,
  calcStock, safeErr
} = require('./_lib/db');

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
      const [pRes, sRes, tRes] = await Promise.all([
        supabase.from('products').select('*').order('created_at'),
        supabase.from('srs').select('*').order('created_at'),
        supabase.from('transactions').select('tx_id,type,product_id,total_units').order('created_at')
      ]);
      const products = (pRes.data || []).map(mapProduct);
      const srsAll   = (sRes.data || []).map(mapSR);
      const allTx    = (tRes.data || []).map(r => ({
        txId: String(r.tx_id || ''), type: r.type || '',
        productId: String(r.product_id || ''), totalUnits: String(r.total_units || 0)
      }));
      return res.json({ ok: true, products, srs: srsAll, stockMap: calcStock(allTx) });
    }

    // ══════════════════════════════════════════════════════
    //  SO DASHBOARD — isolated to SO's own data + assigned DSRs
    // ══════════════════════════════════════════════════════
    if (role === 'so' && userId) {
      const today = new Date().toISOString().slice(0, 10);
      const monthStart = today.slice(0, 7) + '-01';
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
      const [prodRes, txStockRes] = await Promise.all([
        supabase.from('products').select('*').order('created_at'),
        supabase.from('transactions').select('tx_id,type,product_id,total_units').order('created_at')
      ]);
      const products = (prodRes.data || []).map(mapProduct);
      const stockMap = calcStock((txStockRes.data || []).map(r => ({
        txId: String(r.tx_id || ''), type: r.type || '',
        productId: String(r.product_id || ''), totalUnits: String(r.total_units || 0)
      })));

      // Transactions: SO + DSRs, today and this month
      let txTodayQ = supabase.from('transactions').select('*').eq('date', today).order('created_at');
      let txMonthQ = supabase.from('transactions').select('*').gte('date', monthStart).lte('date', today).order('created_at');
      // All-time for due calculation (give/return/damage for DSRs only)
      let txAllDueQ = supabase.from('transactions').select('type,sr_id,total_units,total_revenue').in('type', ['give', 'return', 'damage']).order('created_at');

      if (allIds.length) {
        txTodayQ = txTodayQ.in('sr_id', allIds);
        txMonthQ = txMonthQ.in('sr_id', allIds);
      }
      if (dsrIds.length) {
        txAllDueQ = txAllDueQ.in('sr_id', dsrIds);
      }

      // Custom range query — only fired when both from/to are supplied
      let txRangeQ = null;
      if (allIds.length && rangeFrom && rangeTo) {
        txRangeQ = supabase.from('transactions').select('*')
          .gte('date', rangeFrom).lte('date', rangeTo).in('sr_id', allIds).order('created_at');
      }

      const [txTodayRes, txMonthRes, txAllDueRes, txRangeRes] = await Promise.all([
        allIds.length ? txTodayQ : { data: [] },
        allIds.length ? txMonthQ : { data: [] },
        dsrIds.length ? txAllDueQ : { data: [] },
        txRangeQ ? txRangeQ : { data: [] }
      ]);

      const txToday = (txTodayRes.data || []).map(mapTx);
      const txMonth = (txMonthRes.data || []).map(mapTx);
      const txAllDue = txAllDueRes.data || [];
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
      const monthGiven  = txMonth.filter(r => r.type === 'give' || r.type === 'point_sale').reduce((s, r) => s + num(r.totalRevenue), 0);
      const monthReturn = txMonth.filter(r => r.type === 'return' || r.type === 'point_damage_return').reduce((s, r) => s + num(r.totalRevenue), 0);
      const monthDsrPay = dsrPayMonth.reduce((s, r) => s + num(r.amount), 0);

      return res.json({
        ok: true,
        assignedDsrs,
        dsrDues: { total: totalDsrDue, list: dsrDueList },
        soPayments: soPayments.slice(0, 30),
        soOwnDue,
        products,
        stockMap,
        today: { revenue: todayGiven - todayReturn, split: todaySplit },
        month: { revenue: monthGiven - monthReturn, dsrPayments: monthDsrPay, split: monthSplit },
        range: rangeSplit
      });
    }

    // ══════════════════════════════════════════════════════
    //  DSR DASHBOARD — strictly isolated to own data
    // ══════════════════════════════════════════════════════
    if (role === 'dsr' && userId) {
      const today = new Date().toISOString().slice(0, 10);
      const monthStart = today.slice(0, 7) + '-01';

      const [prodRes, txStockRes, txAllRes, paymentsRes, txMonthRes, payMonthRes] = await Promise.all([
        supabase.from('products').select('*').order('created_at'),
        supabase.from('transactions').select('tx_id,type,product_id,total_units').order('created_at'),
        supabase.from('transactions').select('type,total_units,total_revenue').eq('sr_id', userId).in('type', ['give', 'return', 'damage']).order('created_at'),
        supabase.from('sr_payments').select('*').eq('sr_id', userId).order('date', { ascending: false }),
        supabase.from('transactions').select('*').eq('sr_id', userId).gte('date', monthStart).lte('date', today).order('created_at'),
        supabase.from('sr_payments').select('*').eq('sr_id', userId).gte('date', monthStart).lte('date', today).order('date')
      ]);

      const products = (prodRes.data || []).map(mapProduct);
      const stockMap = calcStock((txStockRes.data || []).map(r => ({
        txId: String(r.tx_id || ''), type: r.type || '',
        productId: String(r.product_id || ''), totalUnits: String(r.total_units || 0)
      })));
      const txAll    = txAllRes.data || [];
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
        txMonth: txMonth.slice(0, 60)
      });
    }

    // ══════════════════════════════════════════════════════
    //  OWNER / MANAGER DASHBOARD — full data
    // ══════════════════════════════════════════════════════
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 7) + '-01';

    const [pRes, sRes, txTodayRes, txMonthRes, txAllRes, payMonthRes, dmgRes, bonRes] = await Promise.all([
      supabase.from('products').select('*').order('created_at'),
      supabase.from('srs').select('*').order('created_at'),
      supabase.from('transactions').select('*').eq('date', today).order('created_at'),
      supabase.from('transactions').select('*').gte('date', monthStart).lte('date', today).order('created_at'),
      supabase.from('transactions').select('tx_id,type,product_id,total_units').order('created_at'),
      supabase.from('sr_payments').select('*').gte('date', monthStart).lte('date', today).order('date'),
      supabase.from('dmg_claims').select('*').eq('status', 'pending').order('created_at'),
      supabase.from('bonus').select('*').order('created_at')
    ]);

    const products    = (pRes.data  || []).map(mapProduct);
    const srs         = (sRes.data  || []).map(mapSR);
    const txToday     = (txTodayRes.data  || []).map(mapTx);
    const txMonth     = (txMonthRes.data  || []).map(mapTx);
    const txAll       = (txAllRes.data    || []);
    const payMonth    = (payMonthRes.data || []).map(mapPayment);
    const dmgPending  = (dmgRes.data      || []).map(mapDmg);
    const bonusRecs   = (bonRes.data      || []).map(mapBonus);

    // ── Stock map ─────────────────────────────────────────
    const stockMap = {};
    txAll.forEach(r => {
      const pid = String(r.product_id || ''); if (!pid) return;
      if (!stockMap[pid]) stockMap[pid] = 0;
      const u = num(r.total_units);
      if (r.type === 'buy')    stockMap[pid] += u;
      if (r.type === 'give')   stockMap[pid] -= u;
      if (r.type === 'return') stockMap[pid] += u;
      if (r.type === 'damage') stockMap[pid] -= u;
      if (r.type === 'point_sale')          stockMap[pid] -= u;
      if (r.type === 'point_damage_return') stockMap[pid] += u;
    });

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

    const [txAllForDues, payAllRes] = await Promise.all([
      supabase.from('transactions').select('type,sr_id,total_units,total_revenue').in('type',['give','return','damage']).order('created_at'),
      supabase.from('sr_payments').select('sr_id,amount').order('date')
    ]);

    (txAllForDues.data || []).forEach(r => {
      const sid = String(r.sr_id || ''); if (!sid) return;
      if (!srDueMap[sid]) srDueMap[sid] = { srId:sid, name:r.sr_name||'', area:'', phone:'', thumb:'', givenUnits:0, returnUnits:0, givenRev:0, returnRev:0, payments:0 };
      const u = num(r.total_units), rev = num(r.total_revenue);
      if (r.type==='give')   { srDueMap[sid].givenUnits += u; srDueMap[sid].givenRev += rev; }
      if (r.type==='return') { srDueMap[sid].returnUnits+= u; srDueMap[sid].returnRev+= rev; }
    });
    (payAllRes.data || []).forEach(r => {
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

    // ── RECENT transactions (last 10) ──────────────────────
    const recentRes = await supabase.from('transactions').select('*').order('created_at',{ascending:false}).limit(10);
    const recent = (recentRes.data||[]).map(mapTx);

    // ── TOTAL STOCK VALUES ─────────────────────────────────
    const totalBuyValue  = stockList.reduce((s,p)=>s+(p.units*(products.find(pr=>pr.id===p.id)?num(products.find(pr=>pr.id===p.id).purchasePrice):0)),0);
    const totalSellValue = totalSell;
    const estimatedProfit = totalSellValue - totalBuyValue;

    // ── LOW STOCK ──────────────────────────────────────────
    const lowStockList = stockList.filter(p=>num(p.lowStockAlert)>0&&p.units<=num(p.lowStockAlert));

    // ── TOP 4 SELLING PRODUCTS — Today & Month, ranked in CASES ────
    //    (AXIION §6 — was "top3, all-time, in pieces"; now 4 items,
    //    two separate live lists, ranking reported in cases not pieces)
    function buildTopSellers(txList, count) {
      const sales = {};
      txList.forEach(r => {
        const pid = String(r.productId || ''); if (!pid) return;
        if (!sales[pid]) sales[pid] = { productId: pid, productName: '', units: 0 };
        if (r.type === 'give' || r.type === 'point_sale') sales[pid].units += num(r.totalUnits);
        if (r.type === 'return' || r.type === 'point_damage_return') sales[pid].units -= num(r.totalUnits);
      });
      products.forEach(p => { if (sales[p.id]) sales[p.id].productName = p.name; });
      return Object.values(sales).filter(p => p.units > 0).sort((a, b) => b.units - a.units).slice(0, count)
        .map(p => {
          const prod = products.find(pr => pr.id === p.productId) || {};
          const cs = num(prod.caseSize) || 1;
          const exactCases = p.units / cs;
          return {
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
    const top4Today = buildTopSellers(txToday, 4);
    const top4Month = buildTopSellers(txMonth, 4);

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
      top4Today,
      top4Month,
      srPerformance: srPerfList,
      recent
    });

  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
