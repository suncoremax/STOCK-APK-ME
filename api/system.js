// Settings, audit log, backup/export, CSV import, data tools, owner-only reset.
const { db, num, str, isDate, route, fail, audit, rpcOrThrow, bdToday, getSettings, checkPin } = require('./_lib/core');
const { pubSettings } = require('./auth');

const SETTING_KEYS = {
  business_name: 's', business_phone: 's', business_address: 's', invoice_footer: 's', invoice_prefix: 's',
  opening_cash: 'n', opening_bank: 'n', books_start: 'd', monthly_target: 'n', due_alert_days: 'n',
  allow_negative_stock: 'b', enforce_credit_limit: 'b', update_cost_on_purchase: 'b', salary_deduct_absent: 'b',
  manager_see_profit: 'b', manager_can_void: 'b', manager_manage_salary: 'b'
};
// what "reset" may clear — a fixed whitelist, never taken from the request
const RESET = {
  transactions: { label: 'বিক্রয়, ক্রয়, ফেরত, লেজার ও স্টক মুভমেন্ট (পণ্যের স্টক ০ হবে)', tables: ['sale_items', 'sales', 'purchase_items', 'purchases', 'adjustments', 'ledger', 'stock_moves'], after: 'zero_stock' },
  money: { label: 'খরচ, ক্যাশ এন্ট্রি, দিনশেষ', tables: ['expenses', 'cash_entries', 'day_close'] },
  staff: { label: 'উপস্থিতি ও বেতনের রেকর্ড', tables: ['attendance', 'salary_payments'] },
  notes: { label: 'নোটিশ ও অডিট লগ', tables: ['notices', 'audit_log'] }
};

module.exports = route({}, async (ctx) => {
  const { q, body, req, user } = ctx;
  const a = q.action || '';
  const owner = user.role === 'owner';

  if (req.method === 'GET' && a === 'settings') {
    const s = ctx.settings;
    if (!owner) return { settings: pubSettings(ctx) };
    return { settings: s, pub: pubSettings(ctx) };
  }
  if (req.method === 'POST' && a === 'settings') {
    if (!owner) fail(403, 'শুধু মালিক সেটিংস বদলাতে পারেন');
    const rows = [];
    for (const k of Object.keys(body.settings || {})) {
      const t = SETTING_KEYS[k]; if (!t) continue;
      const v = body.settings[k];
      let val;
      if (t === 's') val = str(v, 300);
      else if (t === 'n') { val = num(v); if (val < 0) fail(400, 'ঋণাত্মক মান চলবে না'); }
      else if (t === 'b') val = v === true || v === 'true';
      else if (t === 'd') { if (!isDate(v)) fail(400, 'তারিখ ঠিক নেই'); val = v; }
      rows.push({ key: k, value: val });
    }
    if (rows.length) { const r = await db.from('settings').upsert(rows); if (r.error) throw r.error; }
    await audit(ctx, 'settings', { keys: rows.map((r) => r.key) });
    ctx.settings = await getSettings();
    return { pub: pubSettings(ctx) };
  }

  if (req.method === 'GET' && a === 'audit') {
    if (!owner) fail(403, 'শুধু মালিক');
    let qb = db.from('audit_log').select('*').order('at', { ascending: false });
    if (q.user) qb = qb.eq('user_name', q.user);
    const { data, error } = await qb.limit(300);
    if (error) throw error;
    return { rows: data };
  }

  // ── full backup as JSON (owner) ──
  if (req.method === 'GET' && a === 'backup') {
    if (!owner) fail(403, 'শুধু মালিক');
    const tables = ['settings', 'products', 'suppliers', 'employees', 'shops', 'ledger', 'stock_moves', 'sales', 'sale_items', 'purchases', 'purchase_items', 'adjustments', 'expense_cats', 'expenses', 'cash_entries', 'salary_payments', 'attendance', 'day_close', 'notices', 'contacts'];
    const out = { app: 'axiion-business-manager', version: '6.0', at: new Date().toISOString(), tables: {} };
    for (const t of tables) {
      let all = [], from = 0;
      for (;;) {
        const { data, error } = await db.from(t).select('*').range(from, from + 999);
        if (error) throw error;
        all = all.concat(data); if (data.length < 1000) break; from += 1000;
      }
      out.tables[t] = all;
    }
    await audit(ctx, 'backup', {});
    return { backup: out };
  }

  // ── bulk import (CSV parsed in the browser) ──
  if (req.method === 'POST' && a === 'import') {
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 2000) : [];
    if (!rows.length) fail(400, 'ফাইলে কোনো সারি নেই');
    let ok = 0; const errors = [];
    if (body.type === 'products') {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const name = str(r.name, 200); if (!name) { errors.push(`সারি ${i + 2}: নাম নেই`); continue; }
        const rec = { name, sku: str(r.sku, 60), category: str(r.category, 80), case_size: Math.max(1, Math.round(num(r.case_size, 1))), purchase_price: num(r.purchase_price), selling_price: num(r.selling_price), low_stock: num(r.low_stock) };
        const { data, error } = await db.from('products').insert(rec).select('id').single();
        if (error) { errors.push(`সারি ${i + 2}: ${error.message}`); continue; }
        if (num(r.stock) > 0) { try { rpcOrThrow(await db.rpc('fn_post_adjustment', { p: { kind: 'stock_adjust', date: bdToday(), note: 'ইমপোর্ট — প্রারম্ভিক স্টক', by_name: user.name, items: [{ product_id: data.id, units: num(r.stock), price: rec.purchase_price }] } })); } catch (e) { errors.push(`সারি ${i + 2}: স্টক দেওয়া যায়নি`); } }
        ok++;
      }
    } else if (body.type === 'shops') {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const name = str(r.name, 200); if (!name) { errors.push(`সারি ${i + 2}: নাম নেই`); continue; }
        const code = rpcOrThrow(await db.rpc('fn_next_shop_code'));
        const { data, error } = await db.from('shops').insert({ code, name, keeper: str(r.keeper, 100), phone: str(r.phone, 30), address: str(r.address, 300), area: str(r.area, 80), credit_limit: num(r.credit_limit) }).select('id,name').single();
        if (error) { errors.push(`সারি ${i + 2}: ${error.message}`); continue; }
        if (num(r.opening_due) > 0) await db.from('ledger').insert({ party_type: 'shop', party_id: data.id, party_name: data.name, date: bdToday(), kind: 'opening', debit: num(r.opening_due), note: 'প্রারম্ভিক বাকি (ইমপোর্ট)', by_name: user.name });
        ok++;
      }
    } else fail(400, 'ভুল ধরন');
    await audit(ctx, 'import', { type: body.type, ok, errors: errors.length });
    return { imported: ok, errors: errors.slice(0, 30) };
  }

  if (req.method === 'POST' && a === 'resync-stock') {
    if (!owner) fail(403, 'শুধু মালিক');
    const n = rpcOrThrow(await db.rpc('fn_resync_stock'));
    await audit(ctx, 'resync-stock', { products: n });
    return { products: n };
  }

  if (req.method === 'GET' && a === 'reset-info') {
    if (!owner) fail(403, 'শুধু মালিক');
    const out = {};
    for (const k of Object.keys(RESET)) {
      let n = 0;
      for (const t of RESET[k].tables) { const { count } = await db.from(t).select('*', { count: 'exact', head: true }); n += count || 0; }
      out[k] = { label: RESET[k].label, count: n };
    }
    return { info: out };
  }
  if (req.method === 'POST' && a === 'reset') {
    if (!owner) fail(403, 'শুধু মালিক');
    const keys = (body.keys || []).filter((k) => RESET[k]);
    if (!keys.length) fail(400, 'কিছু বেছে নিন');
    if (String(body.confirm || '').trim() !== 'RESET') fail(400, 'নিশ্চিত করতে RESET লিখুন');
    const { data: u } = await db.from('app_users').select('pin_hash').eq('id', user.id).single();
    if (!checkPin(String(body.pin || ''), u.pin_hash)) fail(400, 'পিন ভুল');
    for (const k of keys) {
      for (const t of RESET[k].tables) {
        const col = t === 'audit_log' ? 'id' : t === 'day_close' ? 'date' : t === 'attendance' ? 'employee_id' : 'id';
        const r = col === 'id' && t === 'audit_log' ? await db.from(t).delete().gte('id', 0) : col === 'id' ? await db.from(t).delete().not('id', 'is', null) : col === 'date' ? await db.from(t).delete().gte('date', '0001-01-01') : await db.from(t).delete().not(col, 'is', null);
        if (r.error) throw r.error;
      }
      if (RESET[k].after === 'zero_stock') await db.from('products').update({ stock: 0, damage_stock: 0 }).not('id', 'is', null);
    }
    await audit(ctx, 'reset', { keys });
    return { cleared: keys };
  }
  fail(404, 'অজানা অনুরোধ');
});
