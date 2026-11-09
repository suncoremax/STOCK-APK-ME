// Month summary (cycle 26th → 25th) or any date range: profit, product-wise, date-wise, DSR-wise, bonus/free, damage, expenses.
const { supabase, cors, safeErr, num, ds, today, fetchAll, computeBonusRangeSummary, getDueTotals,
        cyclePeriodBounds, cyclePeriodToday, _noTable, mapSlip, mapExpRecord } = require('./_lib/db');
const { requireAuth, withBiz } = require('./_lib/auth');
const { r2 } = require('./_lib/money');
const { computeProfitFull, isPriv } = require('./_lib/profit');   // v14 — profit = cash + offer, company payments, সমন্বয়
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = withBiz(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!isPriv(req)) return res.status(403).json({ ok: false, forbidden: true, error: 'এই রিপোর্ট শুধু মালিক ও ম্যানেজারের জন্য' });   // v14 role safety
  try {
    const q = req.query || {};
    let from, to, period = '';
    if (DATE_RE.test(q.from || '') && DATE_RE.test(q.to || '')) { from = q.from; to = q.to; }
    else { period = /^\d{4}-\d{2}$/.test(q.period || '') ? q.period : cyclePeriodToday(); const b = cyclePeriodBounds(period); from = b.start; to = b.end; }
    // v10 — optional extras (a missing table never breaks the report)
    const soft = (p) => p.catch(e => { if (_noTable(e)) return []; throw e; });
    const [profit, bonus, tx, pays, exps, claims, srs, prods, depRows, slipRows, expRows, rcptRows] = await Promise.all([
      computeProfitFull(from, to), computeBonusRangeSummary(from, to),
      fetchAll(() => supabase.from('transactions').select('type,date,sr_id,product_id,product_name,sku,total_units,total_revenue,total_cost,commission_amt,discount_amt,rule_case_size')
        .in('type', ['give', 'return', 'damage', 'point_sale', 'point_damage_return']).gte('date', from).lte('date', to)),
      fetchAll(() => supabase.from('sr_payments').select('sr_id,date,cash_amount,commission_amt,discount_amt,damage_amt,bonus_amt,other_amt').gte('date', from).lte('date', to)),
      fetchAll(() => supabase.from('exp_records').select('category_name,amount,date').gte('date', from).lte('date', to)),
      fetchAll(() => supabase.from('dmg_claims').select('product_name,total_units,total_cost,status,date').gte('date', from).lte('date', to)),
      supabase.from('srs').select('id,name,role,display_no').order('role').order('display_no'),
      fetchAll(() => supabase.from('products').select('id,case_size,unit_type')),
      soft(fetchAll(() => supabase.from('company_deposits').select('*').gte('date', from).lte('date', to), { tiebreak: 'date' })),
      fetchAll(() => supabase.from('dayend_slips').select('*').gte('date', from).lte('date', to)),
      fetchAll(() => supabase.from('exp_records').select('*').gte('date', from).lte('date', to)),
      soft(fetchAll(() => supabase.from('company_receipts').select('*').gte('received_date', from).lte('received_date', to)))
    ]);
    const cs = {}; prods.forEach(p => { cs[String(p.id)] = { size: num(p.case_size) || 1, ut: p.unit_type || 'কেস' }; });
    // product-wise
    const P = {};
    tx.forEach(r => {
      const o = P[r.product_id] = P[r.product_id] || { productId: r.product_id, name: r.product_name, sku: r.sku, give: 0, ret: 0, dmg: 0, point: 0, pointRet: 0, rev: 0, cost: 0 };
      const u = num(r.total_units);
      if (num(r.rule_case_size) > 0) o.cs = num(r.rule_case_size);   // v11: pieces-per-case as saved on the line
      if (r.type === 'give') { o.give += u; o.rev += num(r.total_revenue); o.cost += num(r.total_cost); }
      else if (r.type === 'point_sale') { o.point += u; o.rev += num(r.total_revenue); o.cost += num(r.total_cost); }
      else if (r.type === 'return') { o.ret += u; o.rev -= num(r.total_revenue); o.cost -= num(r.total_cost); }
      else if (r.type === 'point_damage_return') { o.pointRet += u; o.rev -= num(r.total_revenue); o.cost -= num(r.total_cost); }
      else if (r.type === 'damage') o.dmg += u;
    });
    const byProduct = Object.values(P).map(o => ({ ...o, net: o.give + o.point - o.ret - o.pointRet, caseSize: o.cs || (cs[o.productId] || { size: 1 }).size, unitType: (cs[o.productId] || { ut: 'কেস' }).ut,
      rev: r2(o.rev), profit: r2(o.rev - o.cost) })).sort((a, b) => b.rev - a.rev);
    // v14 — daily profit: every part belongs to its own date, so Σ daily = range total (a company payment never changes a day's profit)
    const dayCost = {}, dayExp = {}, dayRec = {}, dayDmg = {};
    tx.forEach(r => { const d = ds(r.date), c = num(r.total_cost);
      if (r.type === 'give' || r.type === 'point_sale') dayCost[d] = (dayCost[d] || 0) + c; else if (r.type === 'return' || r.type === 'point_damage_return') dayCost[d] = (dayCost[d] || 0) - c;
      if (r.type === 'damage') dayDmg[d] = (dayDmg[d] || 0) + num(r.total_revenue); });
    exps.forEach(r => { dayExp[ds(r.date)] = (dayExp[ds(r.date)] || 0) + num(r.amount); });
    rcptRows.forEach(r => { if (r.kind === 'bonus' || r.kind === 'damage') dayRec[ds(r.received_date)] = (dayRec[ds(r.received_date)] || 0) + num(r.amount); });
    const OF = profit._offer || { days: {}, payments: [] };
    // date-wise
    const D = {};
    const dslot = (d) => (D[d] = D[d] || { date: d, given: 0, returned: 0, damage: 0, pointSale: 0, commission: 0, discount: 0, bonus: 0, other: 0, cash: 0 });
    tx.forEach(r => { const o = dslot(ds(r.date)); const v = num(r.total_revenue);
      if (r.type === 'give') o.given += v; else if (r.type === 'return') o.returned += v; else if (r.type === 'damage') o.damage += v;
      else if (r.type === 'point_sale') { o.pointSale += v; o.commission += num(r.commission_amt); o.discount += num(r.discount_amt); } else if (r.type === 'point_damage_return') o.returned += v; });
    pays.forEach(r => { const o = dslot(ds(r.date)); o.commission += num(r.commission_amt); o.discount += num(r.discount_amt); o.bonus += num(r.bonus_amt); o.other += num(r.other_amt); o.cash += num(r.cash_amount); });
    Object.keys(OF.days).forEach(d => dslot(d));   // days that only have an offer / সমন্বয় entry
    OF.payments.forEach(p => dslot(p.date));        // days with a company payment (cash received, not profit)
    const byDate = Object.values(D).sort((a, b) => a.date.localeCompare(b.date)).map(o => {
      const od = OF.days[o.date] || { earned: 0, received: 0, pending: 0, adjustment: 0 }, sale = o.given + o.pointSale - o.returned;
      const cashProfit = sale - (dayCost[o.date] || 0) - o.commission - o.discount - o.bonus - o.other - (dayDmg[o.date] || 0) - (dayExp[o.date] || 0) + (dayRec[o.date] || 0);
      return { ...o, cashProfit: r2(cashProfit), offerProfit: od.earned, offerReceived: od.received, offerPending: od.pending, offerAdjustment: od.adjustment, totalProfit: r2(cashProfit + od.earned + od.adjustment),
        companyPay: r2(OF.payments.filter(p => p.date === o.date).reduce((s, p) => s + p.amount, 0)), sale: r2(sale),
        given: r2(o.given), returned: r2(o.returned), damage: r2(o.damage), pointSale: r2(o.pointSale), commission: r2(o.commission), discount: r2(o.discount), bonus: r2(o.bonus), other: r2(o.other), cash: r2(o.cash) }; });
    // DSR-wise
    const list = srs.data || [];
    const dues = await getDueTotals(list.map(s => String(s.id)));
    const S = {}; list.forEach(s => { S[String(s.id)] = { id: String(s.id), name: s.name, role: s.role, displayNo: s.display_no, given: 0, returned: 0, damage: 0, commission: 0, discount: 0, bonus: 0, other: 0, cash: 0 }; });
    tx.forEach(r => { const o = S[r.sr_id]; if (!o) return; const v = num(r.total_revenue); if (r.type === 'give') o.given += v; else if (r.type === 'return') o.returned += v; else if (r.type === 'damage') o.damage += v; });
    pays.forEach(r => { const o = S[r.sr_id]; if (!o) return; o.commission += num(r.commission_amt); o.discount += num(r.discount_amt); o.bonus += num(r.bonus_amt); o.other += num(r.other_amt); o.cash += num(r.cash_amount); });
    const byDsr = Object.values(S).filter(o => o.given || o.returned || o.cash || o.damage).map(o => { const d = dues[o.id] || { givenRev: 0, returnRev: 0, payments: 0 };
      return { ...o, sale: r2(o.given - o.returned), given: r2(o.given), returned: r2(o.returned), damage: r2(o.damage), commission: r2(o.commission), discount: r2(o.discount), bonus: r2(o.bonus), other: r2(o.other), cash: r2(o.cash), due: r2(d.givenRev - d.returnRev - d.payments) }; });
    // expenses / claims
    const E = {}; exps.forEach(r => { E[r.category_name || 'অন্যান্য'] = (E[r.category_name || 'অন্যান্য'] || 0) + num(r.amount); });
    const clm = { pending: 0, cleared: 0, units: 0 }; claims.forEach(c => { clm[c.status === 'cleared' ? 'cleared' : 'pending'] += num(c.total_cost); clm.units += num(c.total_units); });
    // v10 — deposits to the company, day-end slips, expense lines and company receipts of the range
    const dp = depRows.map(r => { const o = num(r.online_amt), b = num(r.bank_amt), c = num(r.cash_amt); return { date: ds(r.date), onlineAmt: r2(o), bankAmt: r2(b), cashAmt: r2(c), total: r2(o + b + c), note: r.note || '' }; })
      .sort((a, b) => a.date.localeCompare(b.date));
    const dsum = (k) => r2(dp.reduce((s, x) => s + x[k], 0));
    const deposits = { rows: dp, online: dsum('onlineAmt'), bank: dsum('bankAmt'), cash: dsum('cashAmt'), total: dsum('total') };
    const slips = slipRows.map(mapSlip).sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt).localeCompare(String(b.createdAt)));
    const expenseRows = expRows.map(mapExpRecord).sort((a, b) => a.date.localeCompare(b.date));
    const receipts = rcptRows.map(r => ({ id: String(r.id), kind: r.kind, period: r.period, amount: r2(r.amount), date: ds(r.received_date), note: r.note || '' })).sort((a, b) => a.date.localeCompare(b.date));
    const { _offer, ...profitOut } = profit;
    const companyPayments = OF.payments.map(p => ({ id: p.id, date: p.date, amount: r2(p.amount), note: p.note || '', adjustment: p.adjustment, kind: p.kind }));   // cash/bank received from the company — NOT sales, NOT profit
    res.json({ ok: true, period, from, to, profit: profitOut, companyPayments, companyPayTotal: r2(companyPayments.reduce((s, p) => s + p.amount, 0)), offerOwed: profit.offerOwed, bonus, byProduct, byDate, byDsr, deposits, slips, expenseRows, receipts,
      expenses: Object.keys(E).map(k => ({ category: k, amount: r2(E[k]) })).sort((a, b) => b.amount - a.amount),
      claims: { pending: r2(clm.pending), cleared: r2(clm.cleared), units: clm.units } });
  } catch (e) { res.json({ ok: false, error: safeErr(e) }); }
});
