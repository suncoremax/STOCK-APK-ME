// Everything that records business activity: sales, purchases, returns, collections, expenses, cash, staff.
const { db, num, str, isDate, isUuid, bdToday, route, fail, audit, can, canSeeCost, rpcOrThrow, monthOf } = require('./_lib/core');

const METHODS = ['cash', 'bank', 'bkash', 'nagad', 'rocket', 'cheque'];
const method = (m) => (METHODS.includes(m) ? m : 'cash');
const dateOr = (d) => (isDate(d) ? d : bdToday());
const lim = (q, d = 100) => Math.min(Math.max(parseInt(q.limit, 10) || d, 1), 500);

function stripCost(ctx, rows, keys) {
  if (canSeeCost(ctx)) return rows;
  const f = (r) => { const c = Object.assign({}, r); keys.forEach((k) => delete c[k]); return c; };
  return Array.isArray(rows) ? rows.map(f) : f(rows);
}
const needVoid = (ctx) => { if (!can(ctx, 'manager_can_void')) fail(403, 'বাতিল করার অনুমতি শুধু মালিকের (সেটিংসে ম্যানেজারকে দেওয়া যায়)'); };

module.exports = route({}, async (ctx) => {
  const { q, body, req, user } = ctx;
  const a = q.action || '';
  const GET = req.method === 'GET', POST = req.method === 'POST', DEL = req.method === 'DELETE';
  const by = user.name;

  // ───────── sales ─────────
  if (POST && a === 'sale') {
    const p = Object.assign({}, body, { by_name: by, date: dateOr(body.date), method: method(body.method) });
    if (!Array.isArray(p.items) || !p.items.length) fail(400, 'পণ্য যোগ করুন');
    const r = rpcOrThrow(await db.rpc('fn_post_sale', { p }));
    if (!r.duplicate) await audit(ctx, 'sale', { inv: r.inv_no, total: r.total, due: r.due });
    return { result: r };
  }
  if (GET && a === 'sales') {
    let qb = db.from('sales').select('*', { count: 'exact' }).order('date', { ascending: false }).order('created_at', { ascending: false });
    if (isDate(q.from)) qb = qb.gte('date', q.from);
    if (isDate(q.to)) qb = qb.lte('date', q.to);
    if (isUuid(q.shop_id)) qb = qb.eq('shop_id', q.shop_id);
    if (isUuid(q.employee_id)) qb = qb.eq('employee_id', q.employee_id);
    if (q.status === 'void' || q.status === 'ok') qb = qb.eq('status', q.status);
    if (q.q) { const s = str(q.q, 40).replace(/[%,()]/g, ''); qb = qb.or(`inv_no.ilike.%${s}%,shop_name.ilike.%${s}%`); }
    const off = Math.max(parseInt(q.offset, 10) || 0, 0);
    const { data, error, count } = await qb.range(off, off + lim(q) - 1);
    if (error) throw error;
    return { rows: stripCost(ctx, data, ['cost']), total: count };
  }
  if (GET && a === 'sale') {
    const { data: s, error } = await db.from('sales').select('*').eq('id', q.id).single();
    if (error) throw error;
    const { data: items } = await db.from('sale_items').select('*').eq('sale_id', q.id).order('product_name');
    let shop = null;
    if (s.shop_id) {
      const { data: sh } = await db.from('shops').select('code,name,keeper,phone,address,area').eq('id', s.shop_id).maybeSingle();
      shop = sh;
      const b = rpcOrThrow(await db.rpc('shop_balance', { p_id: s.shop_id }));
      s.shop_balance = b;
    }
    return { sale: stripCost(ctx, s, ['cost']), items: stripCost(ctx, items || [], ['cost_price']), shop };
  }
  if (POST && a === 'sale-void') {
    needVoid(ctx);
    const r = rpcOrThrow(await db.rpc('fn_void_sale', { p_id: body.id, p_reason: str(body.reason, 200), p_by: by }));
    await audit(ctx, 'sale-void', { id: body.id, inv: r.inv_no, reason: body.reason });
    return {};
  }

  // ───────── purchases (from company) ─────────
  if (POST && a === 'purchase') {
    const p = Object.assign({}, body, { by_name: by, date: dateOr(body.date), method: method(body.method) });
    const r = rpcOrThrow(await db.rpc('fn_post_purchase', { p }));
    if (!r.duplicate) await audit(ctx, 'purchase', { no: r.pur_no, total: r.total, due: r.due });
    return { result: r };
  }
  if (GET && a === 'purchases') {
    let qb = db.from('purchases').select('*', { count: 'exact' }).order('date', { ascending: false }).order('created_at', { ascending: false });
    if (isDate(q.from)) qb = qb.gte('date', q.from);
    if (isDate(q.to)) qb = qb.lte('date', q.to);
    if (isUuid(q.supplier_id)) qb = qb.eq('supplier_id', q.supplier_id);
    if (q.q) { const s = str(q.q, 40).replace(/[%,()]/g, ''); qb = qb.or(`pur_no.ilike.%${s}%,slip_no.ilike.%${s}%,supplier_name.ilike.%${s}%`); }
    const off = Math.max(parseInt(q.offset, 10) || 0, 0);
    const { data, error, count } = await qb.range(off, off + lim(q) - 1);
    if (error) throw error;
    return { rows: data, total: count };
  }
  if (GET && a === 'purchase') {
    const { data: p, error } = await db.from('purchases').select('*').eq('id', q.id).single();
    if (error) throw error;
    const { data: items } = await db.from('purchase_items').select('*').eq('purchase_id', q.id).order('product_name');
    return { purchase: p, items: items || [] };
  }
  if (POST && a === 'purchase-void') {
    needVoid(ctx);
    const r = rpcOrThrow(await db.rpc('fn_void_purchase', { p_id: body.id, p_reason: str(body.reason, 200), p_by: by }));
    await audit(ctx, 'purchase-void', { id: body.id, no: r.pur_no });
    return {};
  }

  // ───────── returns / damage / claims / stock adjust ─────────
  if (POST && a === 'adjustment') {
    if (body.kind === 'stock_adjust' && !can(ctx, 'manager_can_void')) fail(403, 'স্টক সংশোধন শুধু মালিক করতে পারেন (সেটিংসে ম্যানেজারকে দেওয়া যায়)');
    const p = Object.assign({}, body, { by_name: by, date: dateOr(body.date), method: method(body.method) });
    const r = rpcOrThrow(await db.rpc('fn_post_adjustment', { p }));
    if (!r.duplicate) await audit(ctx, 'adjustment:' + body.kind, { no: r.adj_no, amount: r.amount });
    return { result: r };
  }
  if (GET && a === 'adjustments') {
    let qb = db.from('adjustments').select('*').order('date', { ascending: false }).order('created_at', { ascending: false });
    if (q.kind) qb = qb.eq('kind', q.kind);
    if (isDate(q.from)) qb = qb.gte('date', q.from);
    if (isDate(q.to)) qb = qb.lte('date', q.to);
    if (isUuid(q.party_id)) qb = qb.eq('party_id', q.party_id);
    const { data, error } = await qb.limit(lim(q, 200));
    if (error) throw error;
    return { rows: data };
  }
  if (POST && a === 'adjustment-void') {
    needVoid(ctx);
    const r = rpcOrThrow(await db.rpc('fn_void_adjustment', { p_id: body.id, p_by: by }));
    await audit(ctx, 'adjustment-void', { id: body.id, no: r.adj_no });
    return {};
  }
  if (GET && a === 'stock-moves') {
    let qb = db.from('stock_moves').select('*').order('date', { ascending: false }).order('created_at', { ascending: false });
    if (isUuid(q.product_id)) qb = qb.eq('product_id', q.product_id);
    const { data, error } = await qb.limit(lim(q, 200));
    if (error) throw error;
    return { rows: data };
  }

  // ───────── money in/out against shops & companies ─────────
  if (POST && a === 'collect') {
    const amount = num(body.amount);
    if (!(amount > 0)) fail(400, 'টাকার পরিমাণ দিন');
    if (!isUuid(body.shop_id)) fail(400, 'দোকান বেছে নিন');
    const { data: shop } = await db.from('shops').select('id,name').eq('id', body.shop_id).maybeSingle();
    if (!shop) fail(404, 'দোকান পাওয়া যায়নি');
    let empName = '';
    if (isUuid(body.employee_id)) { const { data: e } = await db.from('employees').select('name').eq('id', body.employee_id).maybeSingle(); empName = e ? e.name : ''; }
    const before = num(rpcOrThrow(await db.rpc('shop_balance', { p_id: shop.id })));
    const ins = await db.from('ledger').insert({ party_type: 'shop', party_id: shop.id, party_name: shop.name, date: dateOr(body.date), kind: 'collection', credit: amount, method: method(body.method),
      employee_id: isUuid(body.employee_id) ? body.employee_id : null, employee_name: empName, note: str(body.note, 200), by_name: by, client_token: str(body.client_token, 60) || null }).select('id').single();
    if (ins.error) {
      if (/client_token/.test(ins.error.message || '') && /duplicate/i.test(ins.error.message)) return { duplicate: true, balance: before };
      throw ins.error;
    }
    await audit(ctx, 'collect', { shop: shop.name, amount });
    return { id: ins.data.id, balance: before - amount, overpaid: amount > before };
  }
  if (POST && a === 'supplier-pay') {
    const amount = num(body.amount);
    if (!(amount > 0)) fail(400, 'টাকার পরিমাণ দিন');
    const { data: s } = await db.from('suppliers').select('id,name').eq('id', body.supplier_id).maybeSingle();
    if (!s) fail(404, 'কোম্পানি পাওয়া যায়নি');
    const ins = await db.from('ledger').insert({ party_type: 'supplier', party_id: s.id, party_name: s.name, date: dateOr(body.date), kind: 'payment', debit: amount, method: method(body.method), note: str(body.note, 200), by_name: by, client_token: str(body.client_token, 60) || null });
    if (ins.error) { if (/duplicate/i.test(ins.error.message)) return { duplicate: true }; throw ins.error; }
    await audit(ctx, 'supplier-pay', { supplier: s.name, amount });
    return {};
  }
  // write-off / manual correction of a balance (not a cash movement)
  if (POST && a === 'ledger-adjust') {
    needVoid(ctx);
    const amount = num(body.amount);
    if (!(amount > 0)) fail(400, 'টাকার পরিমাণ দিন');
    if (!['shop', 'supplier'].includes(body.party_type) || !isUuid(body.party_id)) fail(400, 'ভুল পক্ষ');
    const tbl = body.party_type === 'shop' ? 'shops' : 'suppliers';
    const { data: p } = await db.from(tbl).select('id,name').eq('id', body.party_id).maybeSingle();
    if (!p) fail(404, 'পাওয়া যায়নি');
    const inc = body.direction === 'increase';
    const row = { party_type: body.party_type, party_id: p.id, party_name: p.name, date: dateOr(body.date), kind: inc ? 'adjust' : 'writeoff', note: str(body.note, 200) || (inc ? 'বাকি বাড়ানো' : 'বাকি মওকুফ'), by_name: by };
    const shopSide = body.party_type === 'shop';
    row[(shopSide ? inc : !inc) ? 'debit' : 'credit'] = amount;
    const r = await db.from('ledger').insert(row);
    if (r.error) throw r.error;
    await audit(ctx, 'ledger-adjust', { party: p.name, type: body.party_type, dir: body.direction, amount });
    return {};
  }
  if (DEL && a === 'ledger-entry') {
    needVoid(ctx);
    const { data: l } = await db.from('ledger').select('id,kind,ref_id').eq('id', q.id).maybeSingle();
    if (!l) fail(404, 'পাওয়া যায়নি');
    if (!['collection', 'payment', 'adjust', 'writeoff', 'opening'].includes(l.kind)) fail(400, 'এটি বিক্রয়/ক্রয়/ফেরতের অংশ — মূল ডকুমেন্ট বাতিল করুন');
    const r = await db.from('ledger').delete().eq('id', q.id);
    if (r.error) throw r.error;
    await audit(ctx, 'ledger-delete', { id: q.id, kind: l.kind });
    return {};
  }
  if (GET && a === 'ledger') {
    const type = q.party_type === 'supplier' ? 'supplier' : 'shop';
    if (!isUuid(q.party_id)) fail(400, 'পক্ষ বেছে নিন');
    const sign = type === 'shop' ? 1 : -1; // balance = sign * (debit - credit)
    const { data, error } = await db.from('ledger').select('*').eq('party_type', type).eq('party_id', q.party_id).order('date').order('created_at').limit(5000);
    if (error) throw error;
    let run = 0;
    const from = isDate(q.from) ? q.from : '0000-00-00';
    let opening = 0;
    const rows = [];
    for (const r of data) {
      run += sign * (num(r.debit) - num(r.credit));
      if (r.date < from) { opening = run; continue; }
      rows.push(Object.assign({}, r, { balance: run }));
    }
    return { rows, opening, balance: run };
  }

  // ───────── expenses ─────────
  if (POST && a === 'expense') {
    const amount = num(body.amount);
    if (!(amount > 0)) fail(400, 'টাকার পরিমাণ দিন');
    let empName = '';
    if (isUuid(body.employee_id)) { const { data: e } = await db.from('employees').select('name').eq('id', body.employee_id).maybeSingle(); empName = e ? e.name : ''; }
    const r = await db.from('expenses').insert({ date: dateOr(body.date), category: str(body.category, 60) || 'অন্যান্য', amount, method: method(body.method),
      employee_id: isUuid(body.employee_id) ? body.employee_id : null, employee_name: empName, note: str(body.note, 200), by_name: by }).select('id').single();
    if (r.error) throw r.error;
    await audit(ctx, 'expense', { amount, category: body.category });
    return { id: r.data.id };
  }
  if (GET && a === 'expenses') {
    let qb = db.from('expenses').select('*').order('date', { ascending: false }).order('created_at', { ascending: false });
    if (isDate(q.from)) qb = qb.gte('date', q.from);
    if (isDate(q.to)) qb = qb.lte('date', q.to);
    if (q.category) qb = qb.eq('category', q.category);
    const { data, error } = await qb.limit(lim(q, 500));
    if (error) throw error;
    return { rows: data };
  }
  if (DEL && a === 'expense') {
    const { data: e } = await db.from('expenses').select('id,date,amount,category').eq('id', q.id).maybeSingle();
    if (!e) fail(404, 'পাওয়া যায়নি');
    if (!can(ctx, 'manager_can_void') && e.date !== bdToday()) fail(403, 'ম্যানেজার শুধু আজকের খরচ মুছতে পারেন');
    await db.from('expenses').delete().eq('id', q.id);
    await audit(ctx, 'expense-delete', e);
    return {};
  }

  // ───────── cash book entries & day close ─────────
  if (POST && a === 'cash-entry') {
    const amount = num(body.amount);
    if (!(amount > 0)) fail(400, 'টাকার পরিমাণ দিন');
    const kind = body.kind, date = dateOr(body.date), note = str(body.note, 200);
    const KINDS = { capital_in: ['in', true], owner_withdraw: ['out', true], other_income: ['in', false], other_out: ['out', false], bank_deposit: ['x', false], bank_withdraw: ['x', false] };
    if (!KINDS[kind]) fail(400, 'ভুল ধরন');
    if (KINDS[kind][1] && user.role !== 'owner') fail(403, 'শুধু মালিক এটি করতে পারবেন');
    let rows;
    if (kind === 'bank_deposit' || kind === 'bank_withdraw') {
      const gid = require('crypto').randomUUID(), toBank = kind === 'bank_deposit';
      const bm = ['bank', 'bkash', 'nagad', 'rocket'].includes(body.method) ? body.method : 'bank';
      rows = [
        { date, kind, direction: toBank ? 'out' : 'in', amount, method: 'cash', group_id: gid, note, by_name: by },
        { date, kind, direction: toBank ? 'in' : 'out', amount, method: bm, group_id: gid, note, by_name: by }
      ];
    } else rows = [{ date, kind, direction: KINDS[kind][0], amount, method: method(body.method), note, by_name: by }];
    const r = await db.from('cash_entries').insert(rows);
    if (r.error) throw r.error;
    await audit(ctx, 'cash-entry', { kind, amount });
    return {};
  }
  if (GET && a === 'cash-entries') {
    let qb = db.from('cash_entries').select('*').order('date', { ascending: false }).order('created_at', { ascending: false });
    if (isDate(q.from)) qb = qb.gte('date', q.from);
    if (isDate(q.to)) qb = qb.lte('date', q.to);
    const { data, error } = await qb.limit(300);
    if (error) throw error;
    return { rows: data };
  }
  if (DEL && a === 'cash-entry') {
    needVoid(ctx);
    const { data: e } = await db.from('cash_entries').select('id,group_id').eq('id', q.id).maybeSingle();
    if (!e) fail(404, 'পাওয়া যায়নি');
    const r = e.group_id ? await db.from('cash_entries').delete().eq('group_id', e.group_id) : await db.from('cash_entries').delete().eq('id', e.id);
    if (r.error) throw r.error;
    await audit(ctx, 'cash-entry-delete', { id: q.id });
    return {};
  }
  if (GET && a === 'day-close') {
    const d = dateOr(q.date);
    const cb = rpcOrThrow(await db.rpc('fn_cashbook', { p_from: d, p_to: d }));
    const { data } = await db.from('day_close').select('*').eq('date', d).maybeSingle();
    const { data: recent } = await db.from('day_close').select('*').order('date', { ascending: false }).limit(15);
    return { date: d, expected_cash: cb.cash_close, closed: data, recent: recent || [] };
  }
  if (POST && a === 'day-close') {
    const d = dateOr(body.date);
    const cb = rpcOrThrow(await db.rpc('fn_cashbook', { p_from: d, p_to: d }));
    const counted = num(body.counted_cash);
    const r = await db.from('day_close').upsert({ date: d, expected_cash: cb.cash_close, counted_cash: counted, diff: counted - cb.cash_close, note: str(body.note, 300), by_name: by });
    if (r.error) throw r.error;
    await audit(ctx, 'day-close', { date: d, diff: counted - cb.cash_close });
    return { diff: counted - cb.cash_close };
  }

  // ───────── staff: attendance & salary ─────────
  if (GET && a === 'attendance') {
    const m = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : monthOf(bdToday());
    const last = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
    const { data, error } = await db.from('attendance').select('*').gte('date', m + '-01').lte('date', m + '-' + String(last).padStart(2, '0'));
    if (error) throw error;
    return { rows: data, month: m, days: last };
  }
  if (POST && a === 'attendance') {
    const rows = Array.isArray(body.rows) ? body.rows : [body];
    const ok = ['present', 'absent', 'late', 'leave', 'half'];
    const up = [], del = [];
    for (const r of rows) {
      if (!isUuid(r.employee_id) || !isDate(r.date)) continue;
      if (!r.status) del.push(r); else if (ok.includes(r.status)) up.push({ employee_id: r.employee_id, date: r.date, status: r.status, note: str(r.note, 120), by_name: by });
    }
    if (up.length) { const e = await db.from('attendance').upsert(up); if (e.error) throw e.error; }
    for (const r of del) await db.from('attendance').delete().eq('employee_id', r.employee_id).eq('date', r.date);
    return { saved: up.length, cleared: del.length };
  }
  if (GET && a === 'salary-month') {
    if (!can(ctx, 'manager_manage_salary')) fail(403, 'বেতনের তথ্য শুধু মালিক দেখতে পারেন');
    const m = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : monthOf(bdToday());
    const rows = rpcOrThrow(await db.rpc('fn_salary_month', { p_month: m }));
    const { data: pays } = await db.from('salary_payments').select('*').eq('month', m).order('date', { ascending: false });
    return { month: m, rows, payments: pays || [] };
  }
  if (POST && a === 'salary-pay') {
    if (!can(ctx, 'manager_manage_salary')) fail(403, 'বেতন দেওয়ার অনুমতি শুধু মালিকের');
    const amount = num(body.amount);
    if (!(amount > 0) || !isUuid(body.employee_id)) fail(400, 'কর্মী ও টাকার পরিমাণ দিন');
    if (!['salary', 'advance', 'bonus'].includes(body.kind)) fail(400, 'ধরন বেছে নিন');
    const { data: e } = await db.from('employees').select('name').eq('id', body.employee_id).maybeSingle();
    if (!e) fail(404, 'কর্মী পাওয়া যায়নি');
    const date = dateOr(body.date);
    const r = await db.from('salary_payments').insert({ employee_id: body.employee_id, employee_name: e.name, month: /^\d{4}-\d{2}$/.test(body.month || '') ? body.month : monthOf(date), kind: body.kind, amount, method: method(body.method), date, note: str(body.note, 200), by_name: by });
    if (r.error) throw r.error;
    await audit(ctx, 'salary-pay', { employee: e.name, kind: body.kind, amount });
    return {};
  }
  if (DEL && a === 'salary-pay') {
    needVoid(ctx);
    await db.from('salary_payments').delete().eq('id', q.id);
    await audit(ctx, 'salary-delete', { id: q.id });
    return {};
  }
  fail(404, 'অজানা অনুরোধ: ' + a);
});
