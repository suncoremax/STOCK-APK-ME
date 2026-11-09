// Single-business edition tests — run with:  node tests/single-business.test.js   (no database: an in-memory stub replaces Supabase)
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://x.test';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'k';
const path = require('path');
const T = { businesses: [], app_settings: [], user_passwords: [] };
let uid = 0, queries = 0;
function qb(table) {
  const rows = T[table] || (T[table] = []); let f = [], ord = null, lim = null, mode = 'select', patch = null, pending = null;
  const api = {
    select() { return api; }, eq(c, v) { f.push(r => String(r[c]) === String(v)); return api; },
    order(c) { ord = c; return api; }, limit(n) { lim = n; return api; },
    insert(r) {
      mode = 'insert';
      // the real database refuses a 2nd row in `businesses` (unique index one_business_only) — the stub does the same
      if (table === 'businesses' && rows.length) pending = { data: null, error: { message: 'duplicate key value violates unique constraint "one_business_only"' } };
      else { const row = Object.assign({ id: table === 'businesses' ? '00000000-0000-4000-8000-00000000000' + (++uid) : 'a' + (++uid), created_at: new Date().toISOString() }, r); rows.push(row); pending = { data: row, error: null }; }
      return api;
    },
    update(p) { mode = 'update'; patch = p; return api; },
    single() { return Promise.resolve(pending || { data: run()[0] || null, error: null }); },
    maybeSingle() { if (mode === 'update') { const hit = run(); hit.forEach(r => Object.assign(r, patch)); return Promise.resolve({ data: hit[0] || null, error: null }); } return Promise.resolve({ data: run()[0] || null, error: null }); },
    then(res, rej) {
      queries++;
      let out;
      if (mode === 'insert') out = pending;
      else if (mode === 'update') { run().forEach(r => Object.assign(r, patch)); out = { data: null, error: null }; }
      else out = { data: run(), error: null };
      return new Promise(r => setTimeout(r, 5)).then(() => out).then(res, rej);   // a little latency so parallel calls really overlap
    }
  };
  function run() { let o = rows.filter(r => f.every(g => g(r))); if (ord) o = o.slice().sort((a, b) => String(a[ord]) < String(b[ord]) ? -1 : 1); return lim ? o.slice(0, lim) : o; }
  return api;
}
const dbPath = path.resolve(__dirname, '../api/_lib/db.js');
const real = require(dbPath);   // real helpers (fetchUpTo …)
const bizRuns = [];
const stub = Object.assign({}, real, { supabase: { from: qb }, rawSupabase: { from: qb }, bizStore: { run: (c, fn) => { bizRuns.push(c); return fn(); } }, safeErr: e => String(e && e.message || e), cors() { } });
require.cache[dbPath].exports = stub;
const auth = require('../api/_lib/auth.js');
const authApi = require('../api/auth.js');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
function mkRes() { const r = { out: null, setHeader() { }, status() { return r; }, json(p) { r.out = p; return r; }, end() { } }; return r; }
const call = async (handler, method, body, headers, query) => { const res = mkRes(); await handler({ method, body: body || {}, query: query || {}, headers: Object.assign({}, headers) }, res); return res.out; };

(async () => {
  T.user_passwords.push({ user_key: 'owner', user_name: 'Owner', password: auth.hashPin('13579'), must_change_pw: false });

  // ── first login on an empty database creates the one business ──
  ok('starts with no business', T.businesses.length === 0);
  const l = await call(authApi, 'POST', { password: '13579' });
  ok('login ok', l && l.ok && l.token, l);
  ok('login answer carries the business', l.business && l.business.id && l.business.name === 'আমার ব্যবসা' && l.business.cycleDay === null, l.business);
  ok('exactly one business row', T.businesses.length === 1, T.businesses);
  ok('settings row created for it', T.app_settings.length === 1 && T.app_settings[0].business_id === T.businesses[0].id, T.app_settings);
  const bizId = T.businesses[0].id, H = { authorization: 'Bearer ' + l.token };

  // ── GET auth returns the business, no list ──
  const g = await call(authApi, 'GET', null, H);
  ok('GET auth → business', g.ok && g.business.id === bizId && g.businesses === undefined, g);

  // ── protected handlers always run inside THE business, whatever header is sent ──
  const probe = auth.withBiz(async (req, res) => res.json({ ok: true }));
  bizRuns.length = 0;
  await call(probe, 'GET', null, H);
  await call(probe, 'GET', null, Object.assign({ 'x-business-id': '99999999-9999-4999-8999-999999999999' }, H));
  await call(probe, 'GET', null, Object.assign({ 'x-business-id': 'garbage' }, H));
  ok('no header needed / foreign header ignored', bizRuns.length === 3 && bizRuns.every(c => c.id === bizId), bizRuns);
  const noTok = await call(probe, 'GET', null, {});
  ok('no token → handler itself answers (no business context)', noTok.ok === true && bizRuns.length === 3);

  // ── many requests at once = ONE lookup (the app fires 4–7 at start) ──
  auth.forgetBusiness(); queries = 0;
  await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => call(probe, 'GET', null, H)));
  ok('7 parallel requests share one business lookup', queries === 1, queries);
  queries = 0; await call(probe, 'GET', null, H);
  ok('next request is served from cache (0 queries)', queries === 0, queries);

  // ── race on a brand-new database: parallel first requests still create ONE business ──
  T.businesses.length = 0; T.app_settings.length = 0; auth.forgetBusiness();
  await Promise.all([1, 2, 3, 4].map(() => call(probe, 'GET', null, H)));
  ok('parallel first requests → one business', T.businesses.length === 1, T.businesses.length);
  // and even if the in-process guard is bypassed, the database refuses a 2nd row (stub mirrors the unique index)
  const dup = await stub.rawSupabase.from('businesses').insert({ name: 'second' }).select('id').single();
  ok('2nd business rejected by the unique index', !!dup.error && T.businesses.length === 1, dup);

  // ── add / delete are refused; rename + cycle work; first-setup syncs the print name ──
  const add = await call(authApi, 'POST', { action: 'biz-add', name: 'X', cycleDay: 5, pin: '13579' }, H);
  ok('biz-add refused', add.ok === false && T.businesses.length === 1, add);
  const del = await call(authApi, 'POST', { action: 'biz-del', id: T.businesses[0].id, pin: '13579' }, H);
  ok('biz-del refused, data kept', del.ok === false && T.businesses.length === 1, del);
  const bad = await call(authApi, 'POST', { action: 'biz-update', cycleDay: 40 }, H);
  ok('cycle day outside 1–28 refused', bad.ok === false, bad);
  const first = await call(authApi, 'POST', { action: 'biz-update', name: 'রহিম এন্টারপ্রাইজ', cycleDay: 26, firstSetup: true }, H);
  ok('first setup saves name + cycle', first.ok && first.business.name === 'রহিম এন্টারপ্রাইজ' && first.business.cycleDay === 26, first);
  ok('first setup also sets the memo print name', T.app_settings[0] && T.app_settings[0].shop_name === 'রহিম এন্টারপ্রাইজ', T.app_settings);
  const later = await call(authApi, 'POST', { action: 'biz-update', name: 'Rahim Traders', cycleDay: 1 }, H);
  ok('later rename keeps print name untouched', later.ok && T.app_settings[0].shop_name === 'রহিম এন্টারপ্রাইজ', T.app_settings);
  const g2 = await call(authApi, 'GET', null, H);
  ok('GET after rename sees new values (cache dropped)', g2.business.name === 'Rahim Traders' && g2.business.cycleDay === 1, g2.business);

  // ── wrong PIN / no token ──
  const wrong = await call(authApi, 'POST', { password: '00000' }, { 'x-forwarded-for': '9.9.9.9' });
  ok('wrong PIN refused', wrong.ok === false);
  const un = await call(authApi, 'GET', null, {});
  ok('GET without token → 401 style answer', un && un.ok === false && un.auth === true, un);

  // ── fetchUpTo: honours limits above Supabase's 1000-row cap ──
  const DATA = Array.from({ length: 2300 }, (_, i) => ({ id: i }));
  const calls = [];
  const factory = () => ({ range(a, b) { calls.push([a, b]); return Promise.resolve({ data: DATA.slice(a, Math.min(b + 1, a + 1000)), error: null }); } });   // like PostgREST: never more than 1000 per request
  let rows = await real.fetchUpTo(factory, 1500);
  ok('limit 1500 really returns 1500 (a plain .limit(1500) returned 1000)', rows.length === 1500 && rows[1499].id === 1499, rows.length);
  ok('…in two requests', calls.length === 2, calls);
  rows = await real.fetchUpTo(factory, 5000);
  ok('limit above the data returns all 2300, no duplicates', rows.length === 2300 && new Set(rows.map(r => r.id)).size === 2300, rows.length);
  rows = await real.fetchUpTo(() => ({ range() { return Promise.resolve({ data: [{ id: 1 }, { id: 2 }], error: null }); } }), 1500);
  ok('short result = one request, 2 rows', rows.length === 2);
  let threw = false; try { await real.fetchUpTo(() => ({ range() { return Promise.resolve({ data: null, error: { message: 'boom' } }); } }), 10); } catch (e) { threw = /boom/.test(e.message); }
  ok('database error is thrown, not swallowed', threw);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
