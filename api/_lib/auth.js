// api/_lib/auth.js — AXIION DMS (manual edition): ONE owner, signed session token.
//
// Login (POST /api/auth {password}) returns a token. Every other API call must send it as
//   Authorization: Bearer <token>
// The token is an HMAC-SHA256 signature over {user, expiry}; the secret is AUTH_SECRET if you set
// that Vercel variable, otherwise it is derived from SUPABASE_SERVICE_KEY (never sent to the browser).
const crypto = require('crypto');
const { supabase, rawSupabase, bizStore } = require('./db');

const TTL_MS = 12 * 3600 * 1000;   // 12 hours — then the PIN is asked again
const SETUP_PIN = '12345';          // first-setup PIN, valid ONLY until the owner has chosen a PIN of their own
const PIN_RE = /^\d{5}$/;
const validPin = (p) => typeof p === 'string' && PIN_RE.test(p.trim());
const hashPin = (pin) => crypto.createHash('sha256').update('axiion:' + String(pin).trim()).digest('hex');
const secret = () => crypto.createHash('sha256').update('axiion-session:' + (process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_KEY || 'dev')).digest();
const b64 = (b) => Buffer.from(b).toString('base64url');

function signToken(user) {
  const body = b64(JSON.stringify({ u: user, exp: Date.now() + TTL_MS }));
  const sig = b64(crypto.createHmac('sha256', secret()).update(body).digest());
  return body + '.' + sig;
}
function readToken(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const good = crypto.createHmac('sha256', secret()).update(body).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== good.length || !crypto.timingSafeEqual(got, good)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p || !p.u || !p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (e) { return null; }
}
// Call at the top of every protected route. Returns true when the caller is the logged-in owner;
// otherwise it has already answered and the route must stop.
function requireAuth(req, res) {
  const h = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
  const p = readToken(h.replace(/^Bearer\s+/i, ''));
  if (p) { req.user = p.u; return true; }
  res.status(401).json({ ok: false, auth: true, error: 'লগইন করুন' });
  return false;
}
// The owner's PIN check for sensitive actions (delete / edit / reset). Constant-time compare.
async function verifyOwnerPin(pin) {
  if (!validPin(pin)) return false;
  const { data } = await supabase.from('user_passwords').select('password,must_change_pw').eq('user_key', 'owner').maybeSingle();
  if (!data) return false;
  // first-setup state: 12345 is accepted until the owner picks a real PIN (then it stops working for good)
  if (data.must_change_pw && String(pin).trim() === SETUP_PIN) return true;
  const a = Buffer.from(String(data.password)), b = Buffer.from(hashPin(pin));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function needPin(req, res, pin) {
  if (await verifyOwnerPin(String(pin || ''))) return true;
  res.json({ ok: false, error: 'ভুল PIN — আবার চেষ্টা করুন' });
  return false;
}

// ═══════════════ the ONE business (single-business edition) ═══════════════
// This edition runs exactly one business. The browser no longer chooses one: withBiz() finds (or, on the very first
// login, creates) THE business and runs the handler inside its context — from then on every database call is scoped to it
// (see db.js). The tables keep their business_id column so the data layout stays identical to the multi-business edition.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BIZ_TTL = 60000;                 // the business row (name / month cycle) is re-read at most once a minute per server instance
let bizCache = null;                   // { at, row }
let bizInflight = null;                // one shared lookup for requests that arrive together (the app fires 4–7 at once)
const DEFAULT_NAME = 'আমার ব্যবসা';
async function ensureBusiness() {
  if (bizCache && Date.now() - bizCache.at < BIZ_TTL) return bizCache.row;
  if (bizInflight) return bizInflight;
  bizInflight = (async () => {
    const pick = async () => {
      const { data, error } = await rawSupabase.from('businesses').select('id,name,cycle_start_day,created_at').order('created_at').limit(1);
      if (error) throw error;
      return (data && data[0]) || null;
    };
    let row = await pick();
    if (!row) {   // first ever login: create the business (and its settings row); the app then asks for the month cycle
      const ins = await rawSupabase.from('businesses').insert({ name: DEFAULT_NAME }).select('id,name,cycle_start_day,created_at').single();
      if (ins.error) { row = await pick(); if (!row) throw ins.error; }   // a parallel request created it first
      else {
        row = ins.data;
        await rawSupabase.from('app_settings').insert({ business_id: row.id, shop_name: row.name });
      }
    }
    bizCache = { at: Date.now(), row };
    return row;
  })();
  try { return await bizInflight; } finally { bizInflight = null; }
}
function forgetBusiness() { bizCache = null; }
function withBiz(handler) {
  return async (req, res) => {
    if (req.method === 'OPTIONS') return handler(req, res);
    const h = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
    const tk = readToken(h.replace(/^Bearer\s+/i, ''));
    if (!tk) return handler(req, res);   // the handler's own requireAuth answers 401
    let biz;
    try { biz = await ensureBusiness(); } catch (e) { return res.json({ ok: false, error: 'ডাটাবেসে সংযোগ হচ্ছে না — আবার চেষ্টা করুন' }); }
    // v14 — ROLE SAFETY: anyone who is not owner / manager gets every response scrubbed of profit, buy price, offer and ledger figures
    if (!['owner', 'manager'].includes(String(tk.u).toLowerCase())) {
      const { scrub } = require('./profit'); const j = res.json.bind(res);
      res.json = (b) => j(scrub(b));
    }
    return bizStore.run({ id: String(biz.id), name: biz.name, cycleDay: biz.cycle_start_day }, () => handler(req, res));
  };
}

module.exports = { withBiz, ensureBusiness, forgetBusiness, UUID_RE, SETUP_PIN, validPin, hashPin, signToken, readToken, requireAuth, verifyOwnerPin, needPin };
