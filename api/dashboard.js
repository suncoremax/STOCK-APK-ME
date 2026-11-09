// Home screen numbers: today + this month (26th → 25th cycle), dues, stock, bonus.
const { supabase, cors, safeErr, num, today, fetchAll, mapProduct, mapSlip, getSalesSummary, computeProfit, getDueTotals,
        getCaseTotals, cyclePeriodToday, cyclePeriodBounds, _noTable } = require('./_lib/db');
const { requireAuth, withBiz } = require('./_lib/auth');
const { r2 } = require('./_lib/money');
const { computeProfitFull, isPriv, offerRange } = require('./_lib/profit');   // v14 — profit = cash + offer (owner / manager only)

async function period(from, to, priv) {
  const [sales, srT, profit, caseT, pay, due0, dueCol] = await Promise.all([
    getSalesSummary(from, to),
    supabase.rpc('sr_sales_totals', { p_from: from, p_to: to }),
    priv ? computeProfitFull(from, to) : computeProfit(from, to),
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
    damageRev: profit.damageRev, finalProfit: profit.finalProfit, virtualProfit: profit.virtualProfit, baseProfit: profit.baseProfit,
    bonusReceived: profit.bonusReceived, damageReceived: profit.damageReceived, receivable: profit.receivable, receiptsReady: profit.receiptsReady,
    // v14 — offer profit / total profit / company payments (scrubbed from the response for anyone but owner / manager)
    cashProfit: profit.cashProfit, offerProfit: profit.offerProfit, offerReceived: profit.offerReceived, offerPending: profit.offerPending, offerAdjustment: profit.offerAdjustment,
    totalProfit: profit.totalProfit, offerSettledBy: profit.offerSettledBy, normalSales: profit.normalSales, offerDeduction: profit.offerDeduction, actualSales: profit.actualSales, purchaseCost: profit.purchaseCost,
    companyPay: priv ? r2(((profit._offer || {}).payments || []).reduce((s, p) => s + p.amount, 0)) : 0,
    cashDsr: r2(cashDsr), cashShop: r2(cashShopSale + cashShopCol), cashTotal: r2(cashDsr + cashShopSale + cashShopCol),
    cases: caseT
  };
}

module.exports = withBiz(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  try {
    const t = today(), per = cyclePeriodToday(), b = cyclePeriodBounds(per);
    const [td, cy, srs, prods, shopDue, slips] = await Promise.all([
      period(t, t, isPriv(req)), period(b.start, b.end, isPriv(req)),
      supabase.from('srs').select('id,name,role,display_no').order('role').order('display_no'),
      fetchAll(() => supabase.from('products').select('*').order('sort_order')),
      supabase.from('due_calendar').select('amount,paid_amount').neq('status', 'cleared'),
      supabase.from('dayend_slips').select('*').order('created_at', { ascending: false }).limit(6)
    ]);
    // v10 — today's deposit to the company + this month's total
    let deposit = { ready: true, today: null, month: { online: 0, bank: 0, cash: 0, total: 0, days: 0 } };
    try {
      const { data: dr, error: de } = await supabase.from('company_deposits').select('date,online_amt,bank_amt,cash_amt').gte('date', b.start).lte('date', b.end);
      if (de) throw de;
      (dr || []).forEach(r => {
        const o = num(r.online_amt), bk = num(r.bank_amt), c = num(r.cash_amt), m = deposit.month;
        m.online += o; m.bank += bk; m.cash += c; m.total += o + bk + c; m.days++;
        if (String(r.date).slice(0, 10) === t) deposit.today = { online: r2(o), bank: r2(bk), cash: r2(c), total: r2(o + bk + c) };
      });
      Object.keys(deposit.month).forEach(k => { deposit.month[k] = r2(deposit.month[k]); });
    } catch (e) { if (_noTable(e)) deposit = { ready: false, today: null, month: { online: 0, bank: 0, cash: 0, total: 0, days: 0 } }; else throw e; }
    let offerOwed = 0; if (isPriv(req)) { try { offerOwed = (await offerRange(t, t)).owed; } catch (e) { offerOwed = 0; } }   // পাওনা অফার (কোম্পানির কাছে) — all-time balance
    const list = srs.data || [];
    const dues = await getDueTotals(list.map(s => String(s.id)));
    const dsrs = list.map(s => { const o = dues[String(s.id)] || { givenRev: 0, returnRev: 0, payments: 0 };
      return { id: String(s.id), name: s.name, role: s.role, displayNo: s.display_no, due: r2(o.givenRev - o.returnRev - o.payments) }; });
    const P = prods.map(mapProduct);
    let legacyPending = 0;   // v11: old lines still waiting for "পুরনো হিসাব ফ্রিজ" (owner warning on the home screen)
    try { const c = await supabase.from('transactions').select('id', { count: 'exact', head: true }).is('rule_case_size', null); legacyPending = c.count || 0; } catch (e) {}
    res.json({ ok: true, legacyPending, offerOwed: r2(offerOwed), today: t, period: per, bounds: b, todayStats: td, cycleStats: cy, dsrs, deposit,
      totalDsrDue: r2(dsrs.reduce((s, d) => s + Math.max(0, d.due), 0)),
      totalShopDue: r2((shopDue.data || []).reduce((s, r) => s + Math.max(0, num(r.amount) - num(r.paid_amount)), 0)),
      stockValue: r2(P.reduce((s, p) => s + num(p.currentStock) * num(p.purchasePrice), 0)),
      stockUnits: P.reduce((s, p) => s + num(p.currentStock), 0),
      lowStock: P.filter(p => num(p.lowStockAlert) > 0 && num(p.currentStock) <= num(p.lowStockAlert)).map(p => ({ id: p.id, name: p.name, stock: num(p.currentStock), alert: num(p.lowStockAlert), caseSize: num(p.caseSize) || 1 })),
      recentSlips: (slips.data || []).map(mapSlip) });
  } catch (e) { res.json({ ok: false, error: safeErr(e) }); }
});
