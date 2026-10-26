// Month summary (cycle 26th → 25th) or any date range: profit, product-wise, date-wise, DSR-wise, bonus/free, damage, expenses.
const { supabase, cors, safeErr, num, ds, today, fetchAll, computeProfit, computeBonusRangeSummary, getDueTotals,
        cyclePeriodBounds, cyclePeriodToday } = require('./_lib/db');
const { requireAuth } = require('./_lib/auth');
const { r2 } = require('./_lib/money');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  try {
    const q = req.query || {};
    let from, to, period = '';
    if (DATE_RE.test(q.from || '') && DATE_RE.test(q.to || '')) { from = q.from; to = q.to; }
    else { period = /^\d{4}-\d{2}$/.test(q.period || '') ? q.period : cyclePeriodToday(); const b = cyclePeriodBounds(period); from = b.start; to = b.end; }
    const [profit, bonus, tx, pays, exps, claims, srs, prods] = await Promise.all([
      computeProfit(from, to), computeBonusRangeSummary(from, to),
      fetchAll(() => supabase.from('transactions').select('type,date,sr_id,product_id,product_name,sku,total_units,total_revenue,total_cost,commission_amt,discount_amt')
        .in('type', ['give', 'return', 'damage', 'point_sale', 'point_damage_return']).gte('date', from).lte('date', to)),
      fetchAll(() => supabase.from('sr_payments').select('sr_id,date,cash_amount,commission_amt,discount_amt,damage_amt').gte('date', from).lte('date', to)),
      fetchAll(() => supabase.from('exp_records').select('category_name,amount,date').gte('date', from).lte('date', to)),
      fetchAll(() => supabase.from('dmg_claims').select('product_name,total_units,total_cost,status,date').gte('date', from).lte('date', to)),
      supabase.from('srs').select('id,name,role,display_no').order('role').order('display_no'),
      fetchAll(() => supabase.from('products').select('id,case_size,unit_type'))
    ]);
    const cs = {}; prods.forEach(p => { cs[String(p.id)] = { size: num(p.case_size) || 1, ut: p.unit_type || 'কেস' }; });
    // product-wise
    const P = {};
    tx.forEach(r => {
      const o = P[r.product_id] = P[r.product_id] || { productId: r.product_id, name: r.product_name, sku: r.sku, give: 0, ret: 0, dmg: 0, point: 0, pointRet: 0, rev: 0, cost: 0 };
      const u = num(r.total_units);
      if (r.type === 'give') { o.give += u; o.rev += num(r.total_revenue); o.cost += num(r.total_cost); }
      else if (r.type === 'point_sale') { o.point += u; o.rev += num(r.total_revenue); o.cost += num(r.total_cost); }
      else if (r.type === 'return') { o.ret += u; o.rev -= num(r.total_revenue); o.cost -= num(r.total_cost); }
      else if (r.type === 'point_damage_return') { o.pointRet += u; o.rev -= num(r.total_revenue); o.cost -= num(r.total_cost); }
      else if (r.type === 'damage') o.dmg += u;
    });
    const byProduct = Object.values(P).map(o => ({ ...o, net: o.give + o.point - o.ret - o.pointRet, caseSize: (cs[o.productId] || { size: 1 }).size, unitType: (cs[o.productId] || { ut: 'কেস' }).ut,
      rev: r2(o.rev), profit: r2(o.rev - o.cost) })).sort((a, b) => b.rev - a.rev);
    // date-wise
    const D = {};
    const dslot = (d) => (D[d] = D[d] || { date: d, given: 0, returned: 0, damage: 0, pointSale: 0, commission: 0, discount: 0, cash: 0 });
    tx.forEach(r => { const o = dslot(ds(r.date)); const v = num(r.total_revenue);
      if (r.type === 'give') o.given += v; else if (r.type === 'return') o.returned += v; else if (r.type === 'damage') o.damage += v;
      else if (r.type === 'point_sale') { o.pointSale += v; o.commission += num(r.commission_amt); o.discount += num(r.discount_amt); } else if (r.type === 'point_damage_return') o.returned += v; });
    pays.forEach(r => { const o = dslot(ds(r.date)); o.commission += num(r.commission_amt); o.discount += num(r.discount_amt); o.cash += num(r.cash_amount); });
    const byDate = Object.values(D).sort((a, b) => a.date.localeCompare(b.date)).map(o => ({ ...o, sale: r2(o.given + o.pointSale - o.returned),
      given: r2(o.given), returned: r2(o.returned), damage: r2(o.damage), pointSale: r2(o.pointSale), commission: r2(o.commission), discount: r2(o.discount), cash: r2(o.cash) }));
    // DSR-wise
    const list = srs.data || [];
    const dues = await getDueTotals(list.map(s => String(s.id)));
    const S = {}; list.forEach(s => { S[String(s.id)] = { id: String(s.id), name: s.name, role: s.role, displayNo: s.display_no, given: 0, returned: 0, damage: 0, commission: 0, discount: 0, cash: 0 }; });
    tx.forEach(r => { const o = S[r.sr_id]; if (!o) return; const v = num(r.total_revenue); if (r.type === 'give') o.given += v; else if (r.type === 'return') o.returned += v; else if (r.type === 'damage') o.damage += v; });
    pays.forEach(r => { const o = S[r.sr_id]; if (!o) return; o.commission += num(r.commission_amt); o.discount += num(r.discount_amt); o.cash += num(r.cash_amount); });
    const byDsr = Object.values(S).filter(o => o.given || o.returned || o.cash || o.damage).map(o => { const d = dues[o.id] || { givenRev: 0, returnRev: 0, payments: 0 };
      return { ...o, sale: r2(o.given - o.returned), given: r2(o.given), returned: r2(o.returned), damage: r2(o.damage), commission: r2(o.commission), discount: r2(o.discount), cash: r2(o.cash), due: r2(d.givenRev - d.returnRev - d.payments) }; });
    // expenses / claims
    const E = {}; exps.forEach(r => { E[r.category_name || 'অন্যান্য'] = (E[r.category_name || 'অন্যান্য'] || 0) + num(r.amount); });
    const clm = { pending: 0, cleared: 0, units: 0 }; claims.forEach(c => { clm[c.status === 'cleared' ? 'cleared' : 'pending'] += num(c.total_cost); clm.units += num(c.total_units); });
    res.json({ ok: true, period, from, to, profit, bonus, byProduct, byDate, byDsr,
      expenses: Object.keys(E).map(k => ({ category: k, amount: r2(E[k]) })).sort((a, b) => b.amount - a.amount),
      claims: { pending: r2(clm.pending), cleared: r2(clm.cleared), units: clm.units } });
  } catch (e) { res.json({ ok: false, error: safeErr(e) }); }
};
