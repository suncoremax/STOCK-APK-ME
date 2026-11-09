// Paging + speed tests — run with:  node tests/perf-paging.test.js   (no database: in-memory stub)
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://x.test'; process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'k';
const path = require('path');
const T = { businesses: [], user_passwords: [] }; let queries = 0;
const BIZ = '11111111-1111-4111-8111-111111111111', BIZ2 = '22222222-2222-4222-8222-222222222222';
function qb(table) {
  const rows = T[table] || (T[table] = []); const f = []; const api = {
    select() { return api; }, eq(c, v) { f.push(r => String(r[c]) === String(v)); return api; }, order() { return api; },
    maybeSingle() { queries++; return new Promise(r => setTimeout(r, 5)).then(() => ({ data: rows.filter(x => f.every(g => g(x)))[0] || null, error: null })); },
    then(res, rej) { queries++; return new Promise(r => setTimeout(r, 5)).then(() => ({ data: rows.filter(x => f.every(g => g(x))), error: null })).then(res, rej); }
  }; return api;
}
const dbPath = path.resolve(__dirname, '../api/_lib/db.js'); const real = require(dbPath);
const bizRuns = [];
require.cache[dbPath].exports = Object.assign({}, real, { supabase: { from: qb }, rawSupabase: { from: qb }, bizStore: { run: (c, fn) => { bizRuns.push(c); return fn(); } }, safeErr: e => String(e && e.message || e), cors() { } });
const auth = require('../api/_lib/auth.js'), authApi = require('../api/auth.js');
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
const mkRes = () => { const r = { out: null, setHeader() { }, status() { return r; }, json(p) { r.out = p; return r; }, end() { } }; return r; };
const call = async (h, method, body, headers) => { const res = mkRes(); await h({ method, body: body || {}, query: {}, headers: headers || {} }, res); return res.out; };
(async () => {
  T.businesses.push({ id: BIZ, name: 'A', cycle_start_day: 26, created_at: '2026-01-01' }, { id: BIZ2, name: 'B', cycle_start_day: 1, created_at: '2026-01-02' });
  T.user_passwords.push({ user_key: 'owner', user_name: 'Owner', password: auth.hashPin('13579'), must_change_pw: false });
  const l = await call(authApi, 'POST', { password: '13579' });
  ok('login carries the business list (no extra request needed)', l.ok && Array.isArray(l.businesses) && l.businesses.length === 2 && l.businesses[0].name === 'A', l);
  const H = { authorization: 'Bearer ' + l.token };
  const g = await call(authApi, 'GET', null, H); ok('GET auth still lists businesses', g.ok && g.businesses.length === 2, g);
  const probe = auth.withBiz(async (req, res) => res.json({ ok: true }));
  // isolation unchanged: the header decides, unknown / missing business refused
  bizRuns.length = 0;
  await call(probe, 'GET', null, Object.assign({ 'x-business-id': BIZ2 }, H));
  ok('runs inside the chosen business', bizRuns.length === 1 && bizRuns[0].id === BIZ2 && bizRuns[0].cycleDay === 1, bizRuns);
  const none = await call(probe, 'GET', null, H); ok('no business chosen → refused', none.ok === false && none.noBusiness === true, none);
  const ghost = await call(probe, 'GET', null, Object.assign({ 'x-business-id': '99999999-9999-4999-8999-999999999999' }, H)); ok('unknown business → refused', ghost.ok === false && ghost.noBusiness === true, ghost);
  // lookup sharing + cache
  auth.forgetBusiness(); queries = 0;
  await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => call(probe, 'GET', null, Object.assign({ 'x-business-id': BIZ }, H))));
  ok('7 simultaneous requests → 1 business lookup', queries === 1, queries);
  queries = 0; await call(probe, 'GET', null, Object.assign({ 'x-business-id': BIZ }, H)); ok('next request served from cache', queries === 0, queries);
  auth.forgetBusiness(BIZ); queries = 0; await call(probe, 'GET', null, Object.assign({ 'x-business-id': BIZ }, H)); ok('forgetBusiness refreshes', queries === 1, queries);
  // fetchUpTo
  const DATA = Array.from({ length: 2300 }, (_, i) => ({ id: i })), calls = [];
  const factory = () => ({ range(a, b) { calls.push([a, b]); return Promise.resolve({ data: DATA.slice(a, Math.min(b + 1, a + 1000)), error: null }); } });
  let rows = await real.fetchUpTo(factory, 1500); ok('limit 1500 returns 1500 (plain .limit gave 1000)', rows.length === 1500 && rows[1499].id === 1499 && calls.length === 2, [rows.length, calls]);
  rows = await real.fetchUpTo(factory, 5000); ok('all 2300, no duplicates', rows.length === 2300 && new Set(rows.map(r => r.id)).size === 2300, rows.length);
  rows = await real.fetchUpTo(() => ({ range() { return Promise.resolve({ data: [{ id: 1 }], error: null }); } }), 1500); ok('short result = 1 row', rows.length === 1);
  let threw = false; try { await real.fetchUpTo(() => ({ range() { return Promise.resolve({ data: null, error: { message: 'boom' } }); } }), 10); } catch (e) { threw = /boom/.test(e.message); } ok('db error thrown', threw);
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
