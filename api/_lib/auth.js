// api/_lib/auth.js — AXIION DMS (manual edition): ONE owner, signed session token.
//
// Login (POST /api/auth {password}) returns a token. Every other API call must send it as
//   Authorization: Bearer <token>
// The token is an HMAC-SHA256 signature over {user, expiry}; the secret is AUTH_SECRET if you set
// that Vercel variable, otherwise it is derived from SUPABASE_SERVICE_KEY (never sent to the browser).
const crypto = require('crypto');
const { supabase } = require('./db');

const TTL_MS = 30 * 24 * 3600 * 1000;   // 30 days
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
  const { data } = await supabase.from('user_passwords').select('password').eq('user_key', 'owner').maybeSingle();
  if (!data) return false;
  const a = Buffer.from(String(data.password)), b = Buffer.from(hashPin(pin));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function needPin(req, res, pin) {
  if (await verifyOwnerPin(String(pin || ''))) return true;
  res.json({ ok: false, error: 'ভুল PIN — আবার চেষ্টা করুন' });
  return false;
}
module.exports = { validPin, hashPin, signToken, readToken, requireAuth, verifyOwnerPin, needPin };
