const { supabase, cors, now_, safeErr } = require('./_lib/db');

// POST { userKey, role, token } — upsert, keyed uniquely on token (one row
// per physical device install, not per person — see NOTIFICATION_PROTOCOL.md §2).
// DELETE { token } — called on logout; only stops per-user targeting to
// that device, it does NOT touch the device's `all_users` topic subscription
// (that lives in Firebase, not this table).
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'POST') {
      const d = req.body || {};
      const token = String(d.token || '').trim();
      if (!token) return res.json({ ok: false, error: 'token প্রয়োজন' });
      const { error } = await supabase.from('push_tokens').upsert({
        token,
        user_key:   String(d.userKey || ''),
        role:       String(d.role    || ''),
        updated_at: now_()
      }, { onConflict: 'token' });
      if (error) throw error;
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const d = req.body || {};
      const token = String(d.token || '').trim();
      if (!token) return res.json({ ok: false, error: 'token প্রয়োজন' });
      const { error } = await supabase.from('push_tokens').delete().eq('token', token);
      if (error) throw error;
      return res.json({ ok: true });
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
