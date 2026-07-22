// ── Push notification sender (V40) ──────────────────────────────────
// See NOTIFICATION_PROTOCOL.md for the full design. This module is the
// ONLY place that talks to Firebase — everything else (api/send-push.js
// for external/manual sends, and the direct calls from srs/orders/notice
// code for automatic triggers) goes through `sendPush()` here.
//
// Deliberately never throws: a push-notification failure must never break
// the actual business action (placing an order, approving an entry, etc).
// Every caller can safely `await sendPush(...)` without wrapping it in its
// own try/catch.
const { supabase } = require('./db');

let _admin = null;
function _getAdmin() {
  if (_admin) return _admin;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  _admin = admin;
  return _admin;
}

// Precedence: token > userKey > role > topic (topic defaults to
// 'all_users' if nothing else is given at all).
async function _resolveTargets({ token, userKey, role, topic }) {
  if (token) return { tokens: [String(token)] };
  if (userKey) {
    const { data, error } = await supabase.from('push_tokens').select('token').eq('user_key', String(userKey));
    if (error) throw error;
    return { tokens: (data || []).map(r => r.token) };
  }
  if (role) {
    const { data, error } = await supabase.from('push_tokens').select('token').eq('role', String(role));
    if (error) throw error;
    return { tokens: (data || []).map(r => r.token) };
  }
  return { topic: topic || 'all_users' };
}

// title/body required. url/image optional. Exactly one of
// token/userKey/role/topic should be given (token wins if more than one
// is present) — same contract as the /api/send-push HTTP endpoint.
// IMPORTANT: always sent as a "data" message (never FCM's "notification"
// type) so the Android app can build the notification itself and
// deep-link into the WebView — see NOTIFICATION_PROTOCOL.md §2.
async function sendPush({ title, body, url, image, token, userKey, role, topic }) {
  try {
    if (!title || !body) return { ok: false, sent: 0, failed: 0, errors: ['title ও body প্রয়োজন'] };
    const admin = _getAdmin();
    if (!admin) return { ok: false, sent: 0, failed: 0, errors: ['FIREBASE_SERVICE_ACCOUNT_JSON configured নেই'] };

    const dataPayload = { title: String(title), body: String(body) };
    if (url)   dataPayload.url   = String(url);
    if (image) dataPayload.image = String(image);

    const target = await _resolveTargets({ token, userKey, role, topic });

    if (target.topic) {
      await admin.messaging().send({ topic: target.topic, data: dataPayload });
      return { ok: true, sent: 1, failed: 0, errors: [] };
    }

    const tokens = (target.tokens || []).filter(Boolean);
    if (!tokens.length) return { ok: true, sent: 0, failed: 0, errors: [] };

    let sent = 0, failed = 0;
    const errors = [];
    const results = await Promise.allSettled(
      tokens.map(t => admin.messaging().send({ token: t, data: dataPayload }))
    );
    results.forEach(r => {
      if (r.status === 'fulfilled') sent++;
      else { failed++; errors.push(String((r.reason && r.reason.message) || r.reason)); }
    });
    return { ok: true, sent, failed, errors };
  } catch (e) {
    return { ok: false, sent: 0, failed: 0, errors: [String(e.message || e)] };
  }
}

module.exports = { sendPush };
