const { db, num, isDate, isUuid, bdToday, route, fail, canSeeCost, rpcOrThrow } = require('./_lib/core');

function range(q) {
  const to = isDate(q.to) ? q.to : bdToday();
  const from = isDate(q.from) ? q.from : to.slice(0, 8) + '01';
  if (from > to) fail(400, 'শুরুর তারিখ শেষ তারিখের পরে হতে পারে না');
  return { from, to };
}
// managers without the "see profit" switch never receive cost or profit numbers
function hide(ctx, o) {
  if (canSeeCost(ctx)) return o;
  const kill = new Set(['cost', 'profit', 'returns_cost', 'stock_cost', 'value_cost', 'total_cost', 'gross_profit', 'net_profit']);
  const walk = (x) => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') { const c = {}; for (const k of Object.keys(x)) if (!kill.has(k)) c[k] = walk(x[k]); return c; }
    return x;
  };
  return walk(o);
}

module.exports = route({}, async (ctx) => {
  const { q, req } = ctx;
  const a = q.action || '';
  if (req.method !== 'GET') fail(405, 'অনুমোদিত নয়');

  if (a === 'dashboard') {
    const d = isDate(q.date) ? q.date : bdToday();
    return { d: hide(ctx, rpcOrThrow(await db.rpc('fn_dashboard', { p_date: d }))), date: d };
  }
  if (a === 'summary') {
    const { from, to } = range(q);
    return { from, to, r: hide(ctx, rpcOrThrow(await db.rpc('fn_report_summary', { p_from: from, p_to: to }))) };
  }
  if (a === 'by') {
    const { from, to } = range(q);
    if (!['product', 'shop', 'employee', 'category', 'area'].includes(q.dim)) fail(400, 'ভুল রিপোর্ট');
    return { from, to, rows: hide(ctx, rpcOrThrow(await db.rpc('fn_report_by', { p_from: from, p_to: to, p_dim: q.dim }))) };
  }
  if (a === 'dues') {
    const rows = rpcOrThrow(await db.rpc('fn_dues', { p_only_positive: true }));
    const buckets = { b0: 0, b1: 0, b2: 0, b3: 0, total: 0 };
    rows.forEach((r) => { const d = num(r.days_since_pay); const b = num(r.balance); buckets.total += b; if (d <= 7) buckets.b0 += b; else if (d <= 15) buckets.b1 += b; else if (d <= 30) buckets.b2 += b; else buckets.b3 += b; });
    return { rows, buckets };
  }
  if (a === 'payables') {
    const { data: sup } = await db.from('suppliers').select('id,name,phone').eq('active', true);
    const bal = rpcOrThrow(await db.rpc('fn_supplier_balances')); const m = {}; bal.forEach((b) => { m[b.id] = b.balance; });
    return { rows: (sup || []).map((s) => Object.assign({ balance: m[s.id] || 0 }, s)).filter((s) => s.balance !== 0) };
  }
  if (a === 'stock') return { r: hide(ctx, rpcOrThrow(await db.rpc('fn_stock_report'))) };
  if (a === 'cashbook') {
    const { from, to } = range(q);
    return { from, to, r: rpcOrThrow(await db.rpc('fn_cashbook', { p_from: from, p_to: to })) };
  }
  if (a === 'product-history') { // sales of one product, for the product detail pop-up
    if (!isUuid(q.product_id)) fail(400, 'পণ্য বেছে নিন');
    const { from, to } = range(q);
    const { data, error } = await db.from('sale_items').select('units,unit_price,line_total,sales!inner(date,inv_no,shop_name,status)').eq('product_id', q.product_id).eq('sales.status', 'ok').gte('sales.date', from).lte('sales.date', to).limit(300);
    if (error) throw error;
    return { rows: data };
  }
  fail(404, 'অজানা রিপোর্ট');
});
