const { db, sign, hashPin, checkPin, PIN_OK, str, route, fail, audit, authenticate } = require('./_lib/core');

// brute-force brake (per server instance; resets on cold start — enough for a 4–8 digit PIN + delay)
const tries = new Map();
function brake(key) {
  const t = tries.get(key) || { n: 0, until: 0 };
  if (Date.now() < t.until) fail(429, 'অনেকবার ভুল হয়েছে — কিছুক্ষণ পরে চেষ্টা করুন');
  return t;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = route({ public: true }, async (ctx) => {
  const { q, body, req } = ctx;
  const action = q.action || body.action || '';

  if (req.method === 'GET' && action === 'status') {
    const { count } = await db.from('app_users').select('id', { count: 'exact', head: true });
    const { data } = await db.from('settings').select('value').eq('key', 'business_name').maybeSingle();
    return { needsSetup: !count, business: data ? data.value : '' };
  }

  // first run only: create the owner account
  if (req.method === 'POST' && action === 'setup') {
    const { count } = await db.from('app_users').select('id', { count: 'exact', head: true });
    if (count) fail(403, 'সেটআপ আগেই হয়ে গেছে');
    const name = str(body.name, 60), username = str(body.username, 30).toLowerCase(), pin = String(body.pin || '');
    if (!name || !/^[a-z0-9._-]{3,30}$/.test(username)) fail(400, 'নাম ও ইউজারনেম (ইংরেজি অক্ষর/সংখ্যা, কমপক্ষে ৩) দিন');
    if (!PIN_OK(pin)) fail(400, 'পিন ৪–৮ সংখ্যার হতে হবে');
    const { data, error } = await db.from('app_users').insert({ name, username, role: 'owner', pin_hash: hashPin(pin) }).select('id,name,role').single();
    if (error) throw error;
    if (body.business_name) await db.from('settings').upsert({ key: 'business_name', value: str(body.business_name, 80) });
    ctx.user = data; await audit(ctx, 'setup', {});
    return { token: sign(data), user: { id: data.id, name: data.name, role: data.role } };
  }

  if (req.method === 'POST' && action === 'login') {
    const username = str(body.username, 30).toLowerCase(), pin = String(body.pin || '');
    const key = username || 'x';
    const t = brake(key);
    const { data: u } = await db.from('app_users').select('*').eq('username', username).maybeSingle();
    const ok = u && u.active && checkPin(pin, u.pin_hash);
    if (!ok) {
      t.n += 1; if (t.n >= 5) { t.until = Date.now() + 5 * 60e3; t.n = 0; }
      tries.set(key, t); await sleep(600);
      fail(401, 'ইউজারনেম বা পিন ভুল');
    }
    tries.delete(key);
    ctx.user = u; await audit(ctx, 'login', {});
    return { token: sign(u), user: { id: u.id, name: u.name, role: u.role }, mustChange: !!u.must_change };
  }

  // everything below needs a valid login
  await authenticate(ctx, {});
  const me = ctx.user;

  if (req.method === 'GET' && action === 'me') return { user: me, settings: pubSettings(ctx) };

  if (req.method === 'POST' && action === 'change-pin') {
    const { data: u } = await db.from('app_users').select('pin_hash').eq('id', me.id).single();
    if (!checkPin(String(body.old || ''), u.pin_hash)) fail(400, 'বর্তমান পিন ভুল');
    if (!PIN_OK(body.new)) fail(400, 'নতুন পিন ৪–৮ সংখ্যার হতে হবে');
    await db.from('app_users').update({ pin_hash: hashPin(body.new), must_change: false }).eq('id', me.id);
    await audit(ctx, 'change-pin', {});
    return {};
  }

  // ── owner-only user management ──
  if (me.role !== 'owner' && ['users', 'user-save', 'user-reset-pin'].includes(action)) fail(403, 'শুধু মালিক এটি করতে পারবেন');

  if (req.method === 'GET' && action === 'users') {
    const { data, error } = await db.from('app_users').select('id,name,username,role,active,created_at').order('created_at');
    if (error) throw error;
    return { users: data };
  }
  if (req.method === 'POST' && action === 'user-save') {
    const name = str(body.name, 60), username = str(body.username, 30).toLowerCase();
    const role = body.role === 'owner' ? 'owner' : 'manager';
    if (!name) fail(400, 'নাম দিন');
    if (body.id) {
      if (body.id === me.id && (body.active === false || role !== 'owner')) fail(400, 'নিজের অ্যাকাউন্ট বন্ধ বা ডাউনগ্রেড করা যাবে না');
      const { error } = await db.from('app_users').update({ name, role, active: body.active !== false }).eq('id', body.id);
      if (error) throw error;
      await audit(ctx, 'user-update', { id: body.id, role });
      return {};
    }
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) fail(400, 'ইউজারনেম (ইংরেজি অক্ষর/সংখ্যা, কমপক্ষে ৩) দিন');
    if (!PIN_OK(body.pin)) fail(400, 'পিন ৪–৮ সংখ্যার হতে হবে');
    const { error } = await db.from('app_users').insert({ name, username, role, pin_hash: hashPin(body.pin), must_change: true });
    if (error) throw error;
    await audit(ctx, 'user-create', { username, role });
    return {};
  }
  if (req.method === 'POST' && action === 'user-reset-pin') {
    if (!PIN_OK(body.pin)) fail(400, 'পিন ৪–৮ সংখ্যার হতে হবে');
    const { error } = await db.from('app_users').update({ pin_hash: hashPin(body.pin), must_change: true }).eq('id', body.id);
    if (error) throw error;
    await audit(ctx, 'user-reset-pin', { id: body.id });
    return {};
  }
  fail(404, 'অজানা অনুরোধ');
});

// settings the browser may see (managers don't get cost/profit unless allowed)
function pubSettings(ctx) {
  const s = ctx.settings || {};
  return {
    business_name: s.business_name || '', business_phone: s.business_phone || '', business_address: s.business_address || '',
    invoice_footer: s.invoice_footer || '', allow_negative_stock: s.allow_negative_stock === true,
    due_alert_days: s.due_alert_days || 15, monthly_target: s.monthly_target || 0,
    perms: {
      see_profit: ctx.user.role === 'owner' || s.manager_see_profit === true,
      void: ctx.user.role === 'owner' || s.manager_can_void === true,
      salary: ctx.user.role === 'owner' || s.manager_manage_salary === true
    }
  };
}
module.exports.pubSettings = pubSettings;
