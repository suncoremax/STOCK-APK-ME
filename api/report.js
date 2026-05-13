const { supabase, cors, num, ds, mapTx, mapPayment, mapProduct, mapSR } = require('./_lib/db');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { from, to } = req.query;
    if (!from || !to) return res.json({ ok: false, error: 'from/to প্রয়োজন' });

    const [txRes, payRes, srRes, prodRes] = await Promise.all([
      supabase.from('transactions').select('*').gte('date', from).lte('date', to).order('date'),
      supabase.from('sr_payments').select('*').gte('date', from).lte('date', to).order('date'),
      supabase.from('srs').select('*').order('created_at'),
      supabase.from('products').select('*').order('created_at')
    ]);

    const txs   = (txRes.data  || []).map(mapTx);
    const pays  = (payRes.data || []).map(mapPayment);
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
    res.json({ ok: false, error: e.message });
  }
};
