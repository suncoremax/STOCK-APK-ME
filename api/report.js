const {
  supabase, cors, num, ds, str, now_, safeErr,
  mapTx, mapPayment, mapProduct, mapSR, mapDue,
  bdtYesterday, fetchAll
} = require('./_lib/db');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ══════════════════════════════════════════════════════════════════
//  V30 — Daily SO Delivery Report + Due Report
//
//  One product-wise "চালান"-style challan per DSR route under an SO
//  (1st/2nd/… loading = each distinct "give" batch that route received
//  that day, ফেরত = unsold stock brought back, বিক্রয় = loading − ফেরত,
//  টাকা = বিক্রয় × দর) plus a companion shop-wise Due Report (today's
//  due, any carried-over previous due, and a per-shop breakdown).
//  Stored in daily_so_reports, newest 60 dates kept per SO.
// ══════════════════════════════════════════════════════════════════

// Build one route's (a DSR, or the SO's own direct activity) product
// challan for a single calendar date.
async function buildRouteChallan(routeId, routeName, routePhone, routeArea, reportDate, unitTypeMap) {
  const { data, error } = await supabase.from('transactions').select('*')
    .eq('sr_id', routeId).eq('date', reportDate)
    .in('type', ['give', 'return', 'damage'])
    .order('created_at', { ascending: true });
  if (error) throw error;
  const rows = (data || []).map(mapTx);

  // Group 'give' rows into load batches by tx_id — every van-load-finish
  // (or direct give) call shares one tx_id, so distinct tx_ids ordered by
  // time ARE the day's 1st/2nd/… loading events for this route.
  const giveGroups = {};
  rows.filter(r => r.type === 'give').forEach(r => {
    if (!giveGroups[r.txId]) giveGroups[r.txId] = { createdAt: r.createdAt, items: [] };
    giveGroups[r.txId].items.push(r);
  });
  const loadBatches = Object.values(giveGroups).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const loadCount = loadBatches.length;

  const prodMap = {};
  const order = [];
  function getP(r) {
    if (!prodMap[r.productId]) {
      prodMap[r.productId] = {
        productId: r.productId, name: r.productName, sku: r.sku,
        unitType: (unitTypeMap && unitTypeMap[r.productId]) || '',
        loads: new Array(loadCount).fill(0),
        totalLoad: 0, returned: 0, damage: 0,
        giveUnits: 0, giveRevenue: 0
      };
      order.push(r.productId);
    }
    return prodMap[r.productId];
  }

  loadBatches.forEach((batch, idx) => {
    batch.items.forEach(r => {
      const p = getP(r), u = num(r.totalUnits);
      p.loads[idx] += u; p.totalLoad += u;
      p.giveUnits  += u; p.giveRevenue += num(r.totalRevenue);
    });
  });
  rows.filter(r => r.type === 'return').forEach(r => { getP(r).returned += num(r.totalUnits); });
  rows.filter(r => r.type === 'damage').forEach(r => { getP(r).damage  += num(r.totalUnits); });

  const products = order.map(pid => {
    const p = prodMap[pid];
    const sold = Math.max(0, p.totalLoad - p.returned - p.damage);
    const rate = p.giveUnits > 0 ? +(p.giveRevenue / p.giveUnits).toFixed(4) : 0;
    return {
      productId: p.productId, name: p.name, sku: p.sku, unitType: p.unitType,
      loads: p.loads, totalLoad: p.totalLoad, returned: p.returned, damage: p.damage,
      sold, rate, amount: +(sold * rate).toFixed(4)
    };
  }).filter(p => p.totalLoad > 0 || p.returned > 0 || p.damage > 0);

  const totals = products.reduce((s, p) => ({
    totalLoad: s.totalLoad + p.totalLoad, returned: s.returned + p.returned,
    damage: s.damage + p.damage, sold: s.sold + p.sold, amount: +(s.amount + p.amount).toFixed(4)
  }), { totalLoad: 0, returned: 0, damage: 0, sold: 0, amount: 0 });

  return { routeId: String(routeId), routeName: routeName || '', routePhone: routePhone || '', routeArea: routeArea || '', loadCount, products, totals };
}

// Companion Due Report — today's due, previous carried-over due, and a
// shop-wise breakdown, scoped to an SO + every DSR assigned to it.
async function buildDueReportData(soId, reportDate, allIds) {
  const { data, error } = await supabase.from('due_calendar').select('*')
    .in('dsr_id', allIds).eq('client_type', 'shop');
  if (error) throw error;
  const rows = (data || []).map(mapDue);

  let todayTotal = 0, prevTotal = 0;
  const shopMap = {};
  rows.forEach(r => {
    const remaining = num(r.amount) - num(r.paidAmount);
    if (remaining <= 0) return;
    const isToday = r.dueDate === reportDate;
    const isPrev  = r.dueDate < reportDate;
    if (!isToday && !isPrev) return; // ignore any future-dated stray row
    if (isToday) todayTotal += remaining; else prevTotal += remaining;
    const key = r.shopId || ('_noshop_' + r.dsrId);
    if (!shopMap[key]) shopMap[key] = {
      shopId: r.shopId || '', shopNo: '', shopName: r.shopName || (r.dsrName ? (r.dsrName + ' — সরাসরি বাকি') : 'অজানা'),
      shopPhone: '', todayDue: 0, prevDue: 0
    };
    if (isToday) shopMap[key].todayDue += remaining; else shopMap[key].prevDue += remaining;
  });

  const shopIds = Object.values(shopMap).map(s => s.shopId).filter(Boolean);
  if (shopIds.length) {
    const { data: shopRows, error: shopErr } = await supabase.from('shops').select('id,shop_no,phone').in('id', shopIds);
    if (shopErr) throw shopErr;
    const phoneMap = {}, noMap = {};
    (shopRows || []).forEach(s => { phoneMap[String(s.id)] = s.phone || ''; noMap[String(s.id)] = s.shop_no || ''; });
    Object.values(shopMap).forEach(s => { if (s.shopId) { s.shopPhone = phoneMap[s.shopId] || ''; s.shopNo = noMap[s.shopId] || ''; } });
  }

  const shops = Object.values(shopMap)
    .map(s => ({ ...s, totalDue: +(s.todayDue + s.prevDue).toFixed(4) }))
    .filter(s => s.totalDue > 0)
    .sort((a, b) => b.totalDue - a.totalDue);

  return {
    soId: String(soId), reportDate,
    todayTotal: +todayTotal.toFixed(4), prevTotal: +prevTotal.toFixed(4),
    grandTotal: +(todayTotal + prevTotal).toFixed(4),
    shops
  };
}

// Generates (or regenerates) one SO's full daily snapshot — the product
// challan for every route under it, plus the due report — and stores it,
// pruning that SO's history down to the newest 60 dates.
async function generateDailyReportForSO(soRow, reportDate, generatedBy, unitTypeMap) {
  const { data: dsrsData, error: dsrErr } = await supabase.from('srs').select('*').eq('so_id', soRow.id);
  if (dsrErr) throw dsrErr;
  const dsrs = dsrsData || [];
  const allIds = [String(soRow.id), ...dsrs.map(d => String(d.id))];

  const routes = [];
  const soChallan = await buildRouteChallan(String(soRow.id), (soRow.name || '') + ' (SO সরাসরি)', soRow.phone || '', soRow.area || '', reportDate, unitTypeMap);
  if (soChallan.totals.totalLoad > 0 || soChallan.totals.returned > 0 || soChallan.totals.damage > 0) routes.push(soChallan);
  for (const dsr of dsrs) {
    routes.push(await buildRouteChallan(String(dsr.id), dsr.name || '', dsr.phone || '', dsr.area || '', reportDate, unitTypeMap));
  }

  const soTotals = routes.reduce((s, r) => ({
    totalLoad: s.totalLoad + r.totals.totalLoad, returned: s.returned + r.totals.returned,
    damage: s.damage + r.totals.damage, sold: s.sold + r.totals.sold,
    amount: +(s.amount + r.totals.amount).toFixed(4)
  }), { totalLoad: 0, returned: 0, damage: 0, sold: 0, amount: 0 });

  const reportData = {
    soId: String(soRow.id), soName: soRow.name || '', soPhone: soRow.phone || '', soArea: soRow.area || '',
    reportDate, generatedAt: now_(), routes, soTotals
  };
  const dueData = await buildDueReportData(String(soRow.id), reportDate, allIds);

  const { data: upserted, error: upErr } = await supabase.from('daily_so_reports').upsert({
    so_id: String(soRow.id), so_name: soRow.name || '', report_date: reportDate,
    generated_at: now_(), generated_by: generatedBy || '',
    report_data: reportData, due_data: dueData
  }, { onConflict: 'so_id,report_date' }).select().single();
  if (upErr) throw upErr;

  // Prune to the newest 60 dates for this SO.
  const { data: allDates, error: listErr } = await supabase
    .from('daily_so_reports').select('id').eq('so_id', String(soRow.id))
    .order('report_date', { ascending: false });
  if (!listErr && allDates && allDates.length > 60) {
    const toDeleteIds = allDates.slice(60).map(r => r.id);
    if (toDeleteIds.length) await supabase.from('daily_so_reports').delete().in('id', toDeleteIds);
  }
  return upserted;
}

async function fetchUnitTypeMap() {
  const { data, error } = await supabase.from('products').select('id,unit_type');
  if (error) throw error;
  const m = {};
  (data || []).forEach(p => { m[String(p.id)] = p.unit_type || ''; });
  return m;
}

// GET ?action=cron-generate — Vercel Cron hits this at 02:00 Asia/Dhaka
// (see vercel.json). Auth via CRON_SECRET (Vercel sends it automatically
// as an Authorization: Bearer header — see README).
async function handleCronGenerate(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const authHeader = req.headers.authorization || '';
  const secretQ = str(req.query.secret || '', 200);
  const cronSecret = process.env.CRON_SECRET || '';
  const authed = !!cronSecret && (authHeader === 'Bearer ' + cronSecret || secretQ === cronSecret);
  if (!authed) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const reportDate = (req.query.date && DATE_RE.test(req.query.date)) ? req.query.date : bdtYesterday();
  const { data: soRows, error } = await supabase.from('srs').select('*').eq('role', 'so');
  if (error) throw error;
  const unitTypeMap = await fetchUnitTypeMap();
  const results = [];
  for (const so of (soRows || [])) {
    try {
      await generateDailyReportForSO(so, reportDate, 'auto', unitTypeMap);
      results.push({ soId: so.id, soName: so.name, ok: true });
    } catch (e) {
      results.push({ soId: so.id, soName: so.name, ok: false, error: safeErr(e) });
    }
  }
  return res.json({ ok: true, reportDate, count: results.length, results });
}

// POST ?action=daily-generate — Owner-triggered manual (re)generate.
// Body: { ownerPin, soId? ('all' or omitted = every SO), date? }
async function handleDailyGenerate(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const d = req.body || {};
  const ownerPin = str(d.ownerPin || '', 20);
  if (!ownerPin) return res.json({ ok: false, error: 'Owner PIN প্রয়োজন' });

  const { data: ownerRow, error: pinErr } = await supabase
    .from('user_passwords').select('id,user_name').eq('role', 'owner').eq('password', ownerPin).limit(1);
  if (pinErr) throw pinErr;
  if (!ownerRow || !ownerRow.length) return res.json({ ok: false, error: 'ভুল Owner PIN' });
  const generatedBy = ownerRow[0].user_name || 'Owner';

  const reportDate = (d.date && DATE_RE.test(d.date)) ? d.date : bdtYesterday();

  let soRows;
  if (d.soId && d.soId !== 'all') {
    const { data, error } = await supabase.from('srs').select('*').eq('id', d.soId).maybeSingle();
    if (error) throw error;
    if (!data) return res.json({ ok: false, error: 'SO পাওয়া যায়নি' });
    soRows = [data];
  } else {
    const { data, error } = await supabase.from('srs').select('*').eq('role', 'so');
    if (error) throw error;
    soRows = data || [];
  }
  if (!soRows.length) return res.json({ ok: false, error: 'কোনো SO পাওয়া যায়নি — আগে DSR/SO পেজ থেকে একজন SO যোগ করুন' });

  const unitTypeMap = await fetchUnitTypeMap();
  const results = [];
  for (const so of soRows) {
    const row = await generateDailyReportForSO(so, reportDate, generatedBy, unitTypeMap);
    results.push({
      soId: String(so.id), soName: so.name, reportDate,
      generatedAt: row.generated_at, generatedBy: row.generated_by,
      reportData: row.report_data, dueData: row.due_data
    });
  }
  return res.json({ ok: true, reportDate, results });
}

// GET ?action=daily-list&soId= — last 60 stored report dates for one SO.
async function handleDailyList(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const { soId } = req.query;
  if (!soId) return res.json({ ok: false, error: 'soId প্রয়োজন' });
  const { data, error } = await supabase.from('daily_so_reports')
    .select('id,so_id,so_name,report_date,generated_at,generated_by,report_data,due_data')
    .eq('so_id', soId).order('report_date', { ascending: false }).limit(60);
  if (error) throw error;
  const list = (data || []).map(r => ({
    id: r.id, soId: r.so_id, soName: r.so_name, reportDate: ds(r.report_date),
    generatedAt: r.generated_at, generatedBy: r.generated_by,
    soTotals: (r.report_data && r.report_data.soTotals) || {},
    dueGrandTotal: (r.due_data && r.due_data.grandTotal) || 0
  }));
  return res.json({ ok: true, list });
}

// GET ?action=daily-get&soId=&date= — one full stored snapshot (for print/share).
async function handleDailyGet(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const { soId, date } = req.query;
  if (!soId || !date) return res.json({ ok: false, error: 'soId ও date প্রয়োজন' });
  const { data, error } = await supabase.from('daily_so_reports').select('*')
    .eq('so_id', soId).eq('report_date', date).maybeSingle();
  if (error) throw error;
  if (!data) return res.json({ ok: false, error: 'এই তারিখের রিপোর্ট পাওয়া যায়নি' });
  return res.json({
    ok: true, reportDate: ds(data.report_date), soId: data.so_id, soName: data.so_name,
    generatedAt: data.generated_at, generatedBy: data.generated_by,
    reportData: data.report_data, dueData: data.due_data
  });
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  try {
    if (action === 'cron-generate')   return await handleCronGenerate(req, res);
    if (action === 'daily-generate')  return await handleDailyGenerate(req, res);
    if (action === 'daily-list')      return await handleDailyList(req, res);
    if (action === 'daily-get')       return await handleDailyGet(req, res);

    // ── Existing date-range analytics report (unchanged) ──────────────
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
    const { from, to } = req.query;
    if (!from || !to) return res.json({ ok: false, error: 'from/to প্রয়োজন' });

    // Paginated: a wide owner-picked range (e.g. a full month/year report)
    // can pass 1000 transaction rows well within the business's first year.
    const [txRows, payRows, srRes, prodRes] = await Promise.all([
      fetchAll(() => supabase.from('transactions').select('*').gte('date', from).lte('date', to).order('date')),
      fetchAll(() => supabase.from('sr_payments').select('*').gte('date', from).lte('date', to).order('date')),
      supabase.from('srs').select('*').order('created_at'),
      supabase.from('products').select('*').order('sort_order').order('created_at')
    ]);

    const txs   = (txRows  || []).map(mapTx);
    const pays  = (payRows || []).map(mapPayment);
    const srs   = (srRes.data  || []).map(mapSR);
    const prods = (prodRes.data|| []).map(mapProduct);

    if (!txs.length && !pays.length) return res.json({ ok: true, empty: true, from, to });

    // ── Summary totals ──────────────────────────────────────
    const sU = (a, t) => a.filter(r => r.type === t).reduce((s, r) => s + num(r.totalUnits), 0);
    const sR = (a, t) => a.filter(r => r.type === t).reduce((s, r) => s + num(r.totalRevenue), 0);
    const sC = (a, t) => a.filter(r => r.type === t).reduce((s, r) => s + num(r.totalCost), 0);

    const gU  = sU(txs,'give')+sU(txs,'point_sale'), rtU = sU(txs,'return')+sU(txs,'point_damage_return'), dmgU = sU(txs,'damage'), byU = sU(txs,'buy');
    const gR  = sR(txs,'give')+sR(txs,'point_sale'), rtR = sR(txs,'return')+sR(txs,'point_damage_return');
    const gC  = sC(txs,'give')+sC(txs,'point_sale'), rtC = sC(txs,'return')+sC(txs,'point_damage_return'), dmgC = sC(txs,'damage');
    const netRev  = gR - rtR, netCost = gC - rtC;
    const totalPay = pays.reduce((s, r) => s + num(r.amount), 0);

    const totals = {
      givenUnits: gU, returnUnits: rtU, dmgUnits: dmgU, buyUnits: byU,
      soldUnits: gU - rtU, netRevenue: netRev, netCost,
      grossProfit: netRev - netCost, dmgLoss: dmgC, payments: totalPay
    };

    // ── SR-wise ─────────────────────────────────────────────
    const srMap = {};
    srs.forEach(sr => {
      srMap[sr.id] = {
        srId: sr.id, name: sr.name, phone: sr.phone, area: sr.area, thumb: sr.thumb || '',
        givenUnits: 0, returnUnits: 0, dmgUnits: 0, soldUnits: 0,
        givenRev: 0, returnRev: 0, givenCost: 0, returnCost: 0,
        netRev: 0, netCost: 0, profit: 0, payments: 0, due: 0, products: {}
      };
    });

    txs.forEach(r => {
      if (!r.srId || !['give','return','damage'].includes(r.type)) return;
      if (!srMap[r.srId]) srMap[r.srId] = {
        srId: r.srId, name: r.srName, phone: '', area: '', thumb: '',
        givenUnits: 0, returnUnits: 0, dmgUnits: 0, soldUnits: 0,
        givenRev: 0, returnRev: 0, givenCost: 0, returnCost: 0,
        netRev: 0, netCost: 0, profit: 0, payments: 0, due: 0, products: {}
      };
      const sr = srMap[r.srId];
      const u = num(r.totalUnits), rev = num(r.totalRevenue), cost = num(r.totalCost);
      if (!sr.products[r.productId]) sr.products[r.productId] = {
        name: r.productName, sku: r.sku,
        given: 0, returned: 0, damage: 0,
        givenRev: 0, returnRev: 0, givenCost: 0, returnCost: 0
      };
      const p = sr.products[r.productId];
      if (r.type === 'give')   { sr.givenUnits += u; sr.givenRev  += rev; sr.givenCost  += cost; p.given    += u; p.givenRev  += rev; p.givenCost  += cost; }
      if (r.type === 'return') { sr.returnUnits+= u; sr.returnRev += rev; sr.returnCost += cost; p.returned += u; p.returnRev += rev; p.returnCost += cost; }
      if (r.type === 'damage') { sr.dmgUnits   += u; p.damage += u; }
    });

    pays.forEach(r => { if (srMap[r.srId]) srMap[r.srId].payments += num(r.amount); });

    Object.values(srMap).forEach(sr => {
      sr.soldUnits = sr.givenUnits - sr.returnUnits - sr.dmgUnits;
      sr.netRev  = sr.givenRev  - sr.returnRev;
      sr.netCost = sr.givenCost - sr.returnCost;
      sr.profit  = sr.netRev  - sr.netCost;
      sr.due     = sr.netRev  - sr.payments;
      Object.values(sr.products).forEach(p => {
        p.sold    = p.given - p.returned - p.damage;
        p.netRev  = p.givenRev  - p.returnRev;
        p.netCost = p.givenCost - p.returnCost;
        p.profit  = p.netRev - p.netCost;
      });
    });

    // ── Product-wise ────────────────────────────────────────
    const prodMap = {};
    txs.forEach(r => {
      if (!prodMap[r.productId]) {
        const pi = prods.find(p => p.id === r.productId);
        prodMap[r.productId] = {
          name: r.productName, sku: r.sku,
          thumb: pi ? pi.thumb || '' : '',
          purchasePrice: pi ? num(pi.purchasePrice) : num(r.purchasePrice),
          sellingPrice:  pi ? num(pi.sellingPrice)  : num(r.sellingPrice),
          buy: 0, given: 0, returned: 0, damage: 0, sold: 0,
          revenue: 0, cost: 0, profit: 0
        };
      }
      const p = prodMap[r.productId], u = num(r.totalUnits);
      if (r.type === 'buy')    p.buy      += u;
      if (r.type === 'give'   || r.type === 'point_sale')          { p.given   += u; p.revenue += num(r.totalRevenue); p.cost += num(r.totalCost); }
      if (r.type === 'return' || r.type === 'point_damage_return') { p.returned+= u; p.revenue -= num(r.totalRevenue); p.cost -= num(r.totalCost); }
      if (r.type === 'damage') p.damage   += u;
    });
    Object.values(prodMap).forEach(p => { p.sold = p.given - p.returned - p.damage; p.profit = p.revenue - p.cost; });

    // ── Date-wise ───────────────────────────────────────────
    const dayMap = {};
    txs.forEach(r => {
      const d = ds(r.date);
      if (!dayMap[d]) dayMap[d] = { date: d, givenUnits: 0, returnUnits: 0, dmgUnits: 0, revenue: 0, cost: 0, profit: 0 };
      const day = dayMap[d], u = num(r.totalUnits);
      if (r.type === 'give'   || r.type === 'point_sale')          { day.givenUnits  += u; day.revenue += num(r.totalRevenue); day.cost += num(r.totalCost); }
      if (r.type === 'return' || r.type === 'point_damage_return') { day.returnUnits += u; day.revenue -= num(r.totalRevenue); day.cost -= num(r.totalCost); }
      if (r.type === 'damage')   day.dmgUnits    += u;
    });
    Object.values(dayMap).forEach(d => { d.profit = d.revenue - d.cost; });

    const byDate  = Object.values(dayMap).sort((a, b) => b.date.localeCompare(a.date));
    const srPerf  = Object.values(srMap).filter(sr => sr.givenUnits + sr.payments > 0).sort((a, b) => b.soldUnits - a.soldUnits);
    const bySR    = Object.values(srMap).filter(s => s.givenUnits + s.payments > 0);
    const byProduct = Object.values(prodMap);

    res.json({ ok: true, from, to, totals, bySR, byProduct, byDate, srPerformance: srPerf });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
