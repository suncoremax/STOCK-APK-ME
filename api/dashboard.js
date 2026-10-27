// Home screen numbers: today + this month (26th → 25th cycle), dues, stock, bonus.
const { supabase, cors, safeErr, num, today, fetchAll, mapProduct, mapSlip, getSalesSummary, computeProfit, getDueTotals,
        getCaseTotals, cyclePeriodToday, cyclePeriodBounds } = require('./_lib/db');
const { requireAuth } = require('./_lib/auth');
const { r2 } = require('./_lib/money');

async function period(from, to) {
  const [sales, srT, profit, caseT, pay, due0, dueCol] = await Promise.all([
    getSalesSummary(from, to),
    supabase.rpc('sr_sales_totals', { p_from: from, p_to: to }),
    computeProfit(from, to),
    getCaseTotals(from, to, { given: ['give'], returned: ['return'], damage: ['damage'], point: ['point_sale'] }),
    supabase.from('sr_payments').select('cash_amount').gte('date', from).lte('date', to),
    supabase.from('due_calendar').select('initial_paid').gte('entry_date', from).lte('entry_date', to),
    supabase.from('due_collections').select('amount').eq('kind', 'cash').gte('date', from).lte('date', to)
  ]);
  const sum = (arr, f) => (arr || []).reduce((s, r) => s + num(f(r)), 0);
  const t = srT.data || [];
  const give = sum(t, r => r.give_rev), ret = sum(t, r => r.ret_rev), dmg = sum(t, r => r.dmg_rev);
  const cashDsr = sum(pay.data, r => r.cash_amount), cashShopSale = sum(due0.data, r => r.initial_paid), cashShopCol = sum(dueCol.data, r => r.amount);
  return {
    from, to, given: r2(give), returned: r2(ret), damage: r2(dmg), pointSale: r2(sales.outRev - give),
    sale: r2(sales.outRev - sales.inRev), commission: profit.commission, discount: profit.discount, damageLoss: profit.damageLoss,
    bonus: profit.bonus, expenses: profit.expenses, grossProfit: profit.grossProfit, netProfit: profit.netProfit,
    damageRev: profit.damageRev, finalProfit: profit.finalProfit,
    cashDsr: r2(cashDsr), cashShop: r2(cashShopSale + cashShopCol), cashTotal: r2(cashDsr + cashShopSale + cashShopCol),
    cases: caseT
  };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  try {
    const t = today(), per = cyclePeriodToday(), b = cyclePeriodBounds(per);
    const [td, cy, srs, prods, shopDue, slips] = await Promise.all([
      period(t, t), period(b.start, b.end),
      supabase.from('srs').select('id,name,role,display_no').order('role').order('display_no'),
      fetchAll(() => supabase.from('products').select('*').order('sort_order')),
      supabase.from('due_calendar').select('amount,paid_amount').neq('status', 'cleared'),
      supabase.from('dayend_slips').select('*').order('created_at', { ascending: false }).limit(6)
    ]);
    const list = srs.data || [];
    const dues = await getDueTotals(list.map(s => String(s.id)));
    const dsrs = list.map(s => { const o = dues[String(s.id)] || { givenRev: 0, returnRev: 0, payments: 0 };
      return { id: String(s.id), name: s.name, role: s.role, displayNo: s.display_no, due: r2(o.givenRev - o.returnRev - o.payments) }; });
    const P = prods.map(mapProduct);
    res.json({ ok: true, today: t, period: per, bounds: b, todayStats: td, cycleStats: cy, dsrs,
      totalDsrDue: r2(dsrs.reduce((s, d) => s + Math.max(0, d.due), 0)),
      totalShopDue: r2((shopDue.data || []).reduce((s, r) => s + Math.max(0, num(r.amount) - num(r.paid_amount)), 0)),
      stockValue: r2(P.reduce((s, p) => s + num(p.currentStock) * num(p.purchasePrice), 0)),
      stockUnits: P.reduce((s, p) => s + num(p.currentStock), 0),
      lowStock: P.filter(p => num(p.lowStockAlert) > 0 && num(p.currentStock) <= num(p.lowStockAlert)).map(p => ({ id: p.id, name: p.name, stock: num(p.currentStock), alert: num(p.lowStockAlert), caseSize: num(p.caseSize) || 1 })),
      recentSlips: (slips.data || []).map(mapSlip) });
  } catch (e) { res.json({ ok: false, error: safeErr(e) }); }
};
