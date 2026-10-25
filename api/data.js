// Master data: products, shops, suppliers, employees, notices, contacts, expense categories.
const { db, num, str, isDate, isUuid, route, fail, audit, can, canSeeCost, rpcOrThrow, bdToday } = require('./_lib/core');

const T = {
  products: {
    fields: { name: 's', sku: 's', category: 's', unit_name: 's', case_name: 's', case_size: 'i', purchase_price: 'n', selling_price: 'n', low_stock: 'n', supplier_id: 'u', note: 's', active: 'b' },
    required: ['name'], order: ['category', 'name'], used: [['sale_items', 'product_id'], ['purchase_items', 'product_id'], ['stock_moves', 'product_id']]
  },
  shops: {
    fields: { name: 's', keeper: 's', phone: 's', address: 's', area: 's', employee_id: 'u', credit_limit: 'n', promise_date: 'd', note: 's', active: 'b' },
    required: ['name'], order: ['name'], used: [['sales', 'shop_id'], ['ledger', 'party_id'], ['adjustments', 'party_id']]
  },
  suppliers: {
    fields: { name: 's', phone: 's', address: 's', note: 's', active: 'b' },
    required: ['name'], order: ['name'], used: [['purchases', 'supplier_id'], ['ledger', 'party_id']]
  },
  employees: {
    fields: { name: 's', phone: 's', designation: 's', salary: 'n', join_date: 'd', note: 's', active: 'b' },
    required: ['name'], order: ['name'], used: [['attendance', 'employee_id'], ['salary_payments', 'employee_id'], ['sales', 'employee_id'], ['expenses', 'employee_id']]
  },
  notices: { fields: { title: 's', body: 's', pinned: 'b' }, required: ['title'], order: ['created_at'], desc: true, used: [] },
  contacts: { fields: { name: 's', phone: 's', role: 's', note: 's' }, required: ['name'], order: ['name'], used: [] },
  expense_cats: { fields: { name: 's' }, required: ['name'], order: ['name'], used: [] }
};

function clean(cfg, src, partial) {
  const o = {};
  for (const k of Object.keys(cfg.fields)) {
    if (!(k in src)) continue;
    const t = cfg.fields[k], v = src[k];
    if (t === 's') o[k] = str(v, k === 'body' || k === 'note' ? 2000 : 200);
    else if (t === 'n') { o[k] = num(v); if (o[k] < 0) fail(400, 'ঋণাত্মক সংখ্যা চলবে না'); }
    else if (t === 'i') { o[k] = Math.max(1, Math.round(num(v, 1))); }
    else if (t === 'b') o[k] = v === true || v === 'true' || v === 1;
    else if (t === 'u') o[k] = isUuid(v) ? v : null;
    else if (t === 'd') o[k] = isDate(v) ? v : null;
  }
  if (!partial) for (const r of cfg.required) if (!o[r]) fail(400, 'নাম/শিরোনাম দিন');
  return o;
}

module.exports = route({}, async (ctx) => {
  const { q, body, req, user } = ctx;
  const t = q.t, cfg = T[t];
  if (!cfg) fail(400, 'অজানা তালিকা');
  const hideCost = t === 'products' && !canSeeCost(ctx);
  const salaryLocked = t === 'employees' && !can(ctx, 'manager_manage_salary');

  if (req.method === 'GET') {
    if (t === 'shops') {
      let rows = rpcOrThrow(await db.rpc('fn_dues', { p_only_positive: false }));
      if (q.all === '1') { // include inactive
        const { data } = await db.from('shops').select('id,code,name,keeper,phone,area,address,credit_limit,promise_date,employee_name,active').eq('active', false);
        rows = rows.concat((data || []).map((r) => Object.assign({ balance: 0 }, r)));
      }
      return { rows };
    }
    let qb = db.from(t).select('*');
    if (t === 'products' && q.all !== '1') qb = qb.eq('active', true);
    if (['suppliers', 'employees'].includes(t) && q.all !== '1') qb = qb.eq('active', true);
    for (const col of cfg.order) qb = qb.order(col, { ascending: !cfg.desc });
    const { data, error } = await qb.limit(5000);
    if (error) throw error;
    let rows = data;
    if (t === 'suppliers') {
      const bal = rpcOrThrow(await db.rpc('fn_supplier_balances'));
      const m = {}; (bal || []).forEach((b) => { m[b.id] = b.balance; });
      rows = rows.map((r) => Object.assign({ balance: m[r.id] || 0 }, r));
    }
    if (hideCost) rows = rows.map((r) => { const c = Object.assign({}, r); delete c.purchase_price; return c; });
    if (salaryLocked) rows = rows.map((r) => { const c = Object.assign({}, r); delete c.salary; return c; });
    return { rows };
  }

  if (req.method === 'POST') {
    const id = body.id;
    const sensitive = t === 'products' ? 'purchase_price' : t === 'employees' ? 'salary' : null;
    if (['notices', 'contacts', 'expense_cats'].includes(t) === false && user.role !== 'owner' && body.active === false && !can(ctx, 'manager_can_void')) fail(403, 'বন্ধ করার অনুমতি নেই');
    if (id) {
      if (!isUuid(id)) fail(400, 'ভুল আইডি');
      const o = clean(cfg, body, true);
      if (sensitive && (hideCost || salaryLocked)) delete o[sensitive];
      if (t === 'shops' && 'employee_id' in o) { const { data: e } = o.employee_id ? await db.from('employees').select('name').eq('id', o.employee_id).maybeSingle() : { data: null }; o.employee_name = e ? e.name : ''; }
      const { error } = await db.from(t).update(o).eq('id', id);
      if (error) throw error;
      await audit(ctx, t + '-update', { id, name: o.name });
      return {};
    }
    const o = clean(cfg, body, false);
    if (sensitive && (hideCost || salaryLocked)) delete o[sensitive];
    if (t === 'shops') o.code = rpcOrThrow(await db.rpc('fn_next_shop_code'));
    if (t === 'shops' && o.employee_id) { const { data: e } = await db.from('employees').select('name').eq('id', o.employee_id).maybeSingle(); o.employee_name = e ? e.name : ''; }
    if (t === 'notices') o.by_name = user.name;
    const { data, error } = await db.from(t).insert(o).select('*').single();
    if (error) throw error;
    const date = isDate(body.date) ? body.date : bdToday();
    // opening figures go through the ledger / stock history, never by editing balances directly
    if (t === 'shops' && num(body.opening_due) > 0) {
      const r = await db.from('ledger').insert({ party_type: 'shop', party_id: data.id, party_name: data.name, date, kind: 'opening', debit: num(body.opening_due), note: 'প্রারম্ভিক বাকি', by_name: user.name });
      if (r.error) throw r.error;
    }
    if (t === 'suppliers' && num(body.opening_payable) > 0) {
      const r = await db.from('ledger').insert({ party_type: 'supplier', party_id: data.id, party_name: data.name, date, kind: 'opening', credit: num(body.opening_payable), note: 'প্রারম্ভিক বাকি', by_name: user.name });
      if (r.error) throw r.error;
    }
    if (t === 'products' && num(body.opening_stock) > 0) {
      rpcOrThrow(await db.rpc('fn_post_adjustment', { p: { kind: 'stock_adjust', date, note: 'প্রারম্ভিক স্টক', by_name: user.name, items: [{ product_id: data.id, units: num(body.opening_stock), price: num(o.purchase_price) }] } }));
    }
    await audit(ctx, t + '-create', { id: data.id, name: o.name || o.title });
    return { row: data };
  }

  if (req.method === 'DELETE') {
    if (!isUuid(q.id)) fail(400, 'ভুল আইডি');
    if (!can(ctx, 'manager_can_void') && !['notices', 'contacts'].includes(t)) fail(403, 'মুছে ফেলার অনুমতি নেই');
    for (const [tbl, col] of cfg.used) {
      const { count } = await db.from(tbl).select('id', { count: 'exact', head: true }).eq(col, q.id);
      if (count) {
        if ('active' in cfg.fields) { await db.from(t).update({ active: false }).eq('id', q.id); await audit(ctx, t + '-deactivate', { id: q.id }); return { deactivated: true }; }
        fail(400, 'এটি ব্যবহার হয়েছে — মোছা যাবে না');
      }
    }
    const { error } = await db.from(t).delete().eq('id', q.id);
    if (error) throw error;
    await audit(ctx, t + '-delete', { id: q.id });
    return {};
  }
  fail(405, 'অনুমোদিত নয়');
});
