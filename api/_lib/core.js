// Shared helpers: database client, signed login tokens, permissions, small utils.
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
// Tests may inject a fake client through global.__BM_DB__
const db = global.__BM_DB__ || (URL && KEY ? createClient(URL, KEY, { auth: { persistSession: false } }) : null);
const SECRET = process.env.SESSION_SECRET || KEY || 'dev-secret-change-me';
const TOKEN_HOURS = 24 * 14;

// ── tokens: base64url(payload).hmac ──────────────────────────────
const b64 = (b) => Buffer.from(b).toString('base64url');
function sign(user) {
  const payload = b64(JSON.stringify({ id: user.id, name: user.name, role: user.role, exp: Date.now() + TOKEN_HOURS * 3600e3 }));
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verify(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [payload, mac] = token.split('.');
  const good = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch (e) { return null; }
}

// ── PIN hashing (scrypt) ─────────────────────────────────────────
function hashPin(pin) {
  const salt = crypto.randomBytes(12).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
function checkPin(pin, stored) {
  if (!stored || stored.indexOf(':') < 0) return false;
  const [salt, h] = stored.split(':');
  const x = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h));
}
const PIN_OK = (p) => /^\d{4,8}$/.test(String(p || ''));

// ── small utils ──────────────────────────────────────────────────
const num = (v, d = 0) => { const n = Number(v); return isFinite(n) ? n : d; };
const str = (v, max = 300) => String(v == null ? '' : v).trim().slice(0, max);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
function bdToday() { // Bangladesh date (UTC+6) — Vercel runs in UTC
  return new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10);
}
const monthOf = (d) => String(d).slice(0, 7);

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function getSettings() {
  const { data, error } = await db.from('settings').select('key,value');
  if (error) throw error;
  const o = {};
  (data || []).forEach((r) => { o[r.key] = r.value; });
  return o;
}

async function authenticate(ctx, opts) {
  const h = String(ctx.req.headers.authorization || '');
  const u = verify(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!u) fail(401, 'আবার লগইন করুন');
  // the token proves who you were — re-check the account is still active
  const { data } = await db.from('app_users').select('id,name,role,active').eq('id', u.id).maybeSingle();
  if (!data || !data.active) fail(401, 'অ্যাকাউন্ট বন্ধ আছে');
  ctx.user = { id: data.id, name: data.name, role: data.role };
  if (opts && opts.owner && ctx.user.role !== 'owner') fail(403, 'শুধু মালিক এটি করতে পারবেন');
  ctx.settings = await getSettings();
}

// Wrap a handler: CORS, auth, role check, error → JSON
// opts.public = no login needed; opts.owner = owner only
function route(opts, fn) {
  return async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    try {
      if (!db) fail(500, 'সার্ভার সেটআপ অসম্পূর্ণ: SUPABASE_URL ও SUPABASE_SERVICE_KEY দিন');
      const ctx = { req, res, q: req.query || {}, body: req.body || {}, user: null, settings: null };
      if (!opts.public) await authenticate(ctx, opts);
      const out = await fn(ctx);
      if (out !== undefined && !res.writableEnded) res.status(200).json(Object.assign({ ok: true }, out));
    } catch (e) {
      const code = e.code && Number.isInteger(e.code) ? e.code : 400;
      if (!(e instanceof HttpError)) console.error('[api]', e && e.message);
      res.status(code).json({ ok: false, error: friendly(e) });
    }
  };
}
function friendly(e) {
  const m = String((e && (e.message || e.details)) || e);
  if (e instanceof HttpError) return m;
  if (/duplicate key/i.test(m)) return 'এই তথ্য আগেই আছে';
  if (/violates foreign key/i.test(m)) return 'এটি অন্য রেকর্ডে ব্যবহার হচ্ছে';
  if (/function .* does not exist|relation .* does not exist|schema cache/i.test(m)) return 'ডাটাবেস সেটআপ অসম্পূর্ণ — schema.sql ও functions.sql চালান';
  return m.slice(0, 300);
}

async function audit(ctx, action, detail) {
  try { await db.from('audit_log').insert({ user_name: ctx.user ? ctx.user.name : '', role: ctx.user ? ctx.user.role : '', action, detail: detail || {} }); } catch (e) { /* never block the real work */ }
}

// A manager's powers are switchable by the owner in Settings.
function can(ctx, what) {
  if (ctx.user.role === 'owner') return true;
  const s = ctx.settings || {};
  return s[what] === true;
}
const canSeeCost = (ctx) => can(ctx, 'manager_see_profit');

function rpcOrThrow(r) { if (r.error) throw r.error; return r.data; }

module.exports = { authenticate, db, sign, verify, hashPin, checkPin, PIN_OK, num, str, isDate, isUuid, bdToday, monthOf, HttpError, fail, cors, route, audit, can, canSeeCost, getSettings, rpcOrThrow };
