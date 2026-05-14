const { supabase, cors, safeErr } = require('./_lib/db');

const PIN_RE = /^\d{5}$/;
function validPin(p) { return typeof p === 'string' && PIN_RE.test(p.trim()); }

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // POST: validate password → return role + user info
    if (req.method === 'POST') {
      const { password } = req.body || {};
      if (!password) return res.json({ ok: false, error: 'পাসওয়ার্ড দিন' });
      const pin = String(password).trim();
      if (!validPin(pin)) return res.json({ ok: false, error: 'ভুল পাসওয়ার্ড' });

      const { data, error } = await supabase
        .from('user_passwords')
        .select('*')
        .eq('password', pin)
        .limit(1);

      if (error) throw error;
      if (!data || !data.length) return res.json({ ok: false, error: 'ভুল পাসওয়ার্ড' });

      const u = data[0];
      return res.json({
        ok: true,
        role:     u.role,
        userId:   u.user_key,
        userName: u.user_name
      });
    }

    // GET: list all users (for owner's password manager)
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('user_passwords')
        .select('user_key,user_name,role,password')
        .order('created_at');
      if (error) throw error;
      return res.json({ ok: true, users: data || [] });
    }

    // PUT: change/set passwords
    if (req.method === 'PUT') {
      const d = req.body || {};

      // User changing own password (requires old password)
      if (d.action === 'change') {
        if (!validPin(String(d.newPass || ''))) return res.json({ ok: false, error: 'নতুন PIN অবশ্যই ৫ সংখ্যার হতে হবে' });
        const { data: existing } = await supabase
          .from('user_passwords')
          .select('id')
          .eq('user_key', d.userKey)
          .eq('password', String(d.oldPass || '').trim())
          .limit(1);
        if (!existing || !existing.length)
          return res.json({ ok: false, error: 'পুরানো পাসওয়ার্ড ভুল' });
        const { error } = await supabase
          .from('user_passwords')
          .update({ password: String(d.newPass).trim() })
          .eq('user_key', d.userKey);
        if (error) throw error;
        return res.json({ ok: true });
      }

      // Owner setting any user's password (no old pass needed)
      if (d.action === 'owner_set') {
        if (!validPin(String(d.newPass || ''))) return res.json({ ok: false, error: 'PIN অবশ্যই ৫ সংখ্যার হতে হবে' });
        const { error } = await supabase
          .from('user_passwords')
          .update({ password: String(d.newPass).trim() })
          .eq('user_key', d.userKey);
        if (error) throw error;
        return res.json({ ok: true });
      }

      // update_meta: rename/re-role a user without touching their password
      if (d.action === 'update_meta') {
        const { error } = await supabase
          .from('user_passwords')
          .update({ user_name: String(d.userName || ''), role: String(d.role || 'dsr') })
          .eq('user_key', String(d.userKey));
        if (error) throw error;
        return res.json({ ok: true });
      }

      // Create or update a user entry (called when DSR/SO is enrolled)
      if (d.action === 'upsert') {
        let pin = String(d.password || '');
        // autoPin: generate a collision-free 5-digit PIN server-side
        if (d.autoPin) {
          pin = '';
          for (let i = 0; i < 60; i++) {
            const candidate = String(10000 + Math.floor(Math.random() * 90000));
            const { data: clash } = await supabase
              .from('user_passwords').select('id').eq('password', candidate).limit(1);
            if (!clash || !clash.length) { pin = candidate; break; }
          }
          if (!pin) return res.json({ ok: false, error: 'PIN তৈরি করা সম্ভব হয়নি' });
        }
        const { error } = await supabase
          .from('user_passwords')
          .upsert({
            user_key:  String(d.userKey),
            user_name: String(d.userName || ''),
            role:      String(d.role || 'dsr'),
            password:  pin
          }, { onConflict: 'user_key' });
        if (error) throw error;
        return res.json({ ok: true, password: pin });
      }

      // Delete a user entry (when DSR/SO is removed)
      if (d.action === 'delete') {
        const { error } = await supabase
          .from('user_passwords')
          .delete()
          .eq('user_key', d.userKey);
        if (error) throw error;
        return res.json({ ok: true });
      }

      return res.json({ ok: false, error: 'অজানা action' });
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
