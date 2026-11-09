const { supabase, rawSupabase, cors, safeErr, bdtToday, str } = require('./_lib/db');
const { validPin, hashPin, signToken, requireAuth, verifyOwnerPin, ensureBusiness, forgetBusiness } = require('./_lib/auth');

const SETUP_PIN = '12345';   // first-setup PIN — the app forces a change right after the first login
const crypto = require('crypto');
const samePin = (stored, pin) => { const a = Buffer.from(String(stored)), b = Buffer.from(hashPin(pin)); return a.length === b.length && crypto.timingSafeEqual(a, b); };

// ── the business (this edition runs exactly ONE; it is created automatically on the first login) ──
const bizOut = (r) => ({ id: String(r.id), name: r.name || '', cycleDay: r.cycle_start_day == null ? null : Number(r.cycle_start_day), createdAt: r.created_at || '' });
const cleanDay = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 28 ? n : null; };
const hits = new Map();   // best-effort login throttle (per server instance)
function throttled(ip) {
  const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 600000);
  hits.set(ip, h); return h.length >= 8;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const d = req.body || {};
    // ── login ──
    if (req.method === 'POST' && !d.action) {
      const ip = String((req.headers['x-forwarded-for'] || '')).split(',')[0].trim() || 'x';
      if (throttled(ip)) return res.json({ ok: false, error: 'অনেকবার ভুল হয়েছে — ১০ মিনিট পরে চেষ্টা করুন' });
      const pin = String(d.password || '').trim();
      // tell a wrong PIN apart from a broken setup (wrong Supabase keys / schema.sql not run yet)
      const [probe, biz0] = await Promise.all([
        supabase.from('user_passwords').select('user_key,user_name,password,must_change_pw').eq('user_key', 'owner').maybeSingle(),
        ensureBusiness().catch(() => null)   // warm the business lookup in parallel so the next screen needs no extra round trip
      ]);
      if (probe.error) return res.json({ ok: false, error: 'ডাটাবেসে সংযোগ হচ্ছে না — Vercel-এ SUPABASE_URL ও SUPABASE_SERVICE_KEY (service_role) ঠিক আছে কিনা এবং schema.sql চালানো হয়েছে কিনা দেখুন' });
      // FIRST SETUP: if the Owner row is missing, create it with the setup PIN (12345) — no manual SQL needed.
      if (!probe.data) {
        const ins = await supabase.from('user_passwords').insert({ user_key: 'owner', user_name: 'Owner', role: 'owner', password: hashPin(SETUP_PIN), must_change_pw: true });
        if (ins.error) return res.json({ ok: false, error: 'Owner অ্যাকাউন্ট তৈরি করা যায়নি — Supabase-এ schema.sql চালান' });
        probe.data = { user_key: 'owner', user_name: 'Owner', password: hashPin(SETUP_PIN), must_change_pw: true };
      }
      // Still in first-setup state (owner never chose a PIN) → the setup PIN 12345 always works,
      // and the stored hash is repaired in case it was written wrongly.
      if (probe.data.must_change_pw && pin === SETUP_PIN) {
        if (probe.data.password !== hashPin(SETUP_PIN)) await supabase.from('user_passwords').update({ password: hashPin(SETUP_PIN) }).eq('user_key', 'owner');
      } else if (!validPin(pin) || !samePin(probe.data.password, pin)) {
        hits.get(ip).push(Date.now());
        return res.json({ ok: false, error: 'ভুল পাসওয়ার্ড' });
      }
      const data = probe.data;   // already loaded above — no extra database round trips
      return res.json({ ok: true, role: 'owner', userId: 'owner', userName: (data && data.user_name) || 'Owner', token: signToken('owner'), mustChangePw: !!(data && data.must_change_pw), business: biz0 ? bizOut(biz0) : null });
    }
    // everything below needs a valid session
    if (!requireAuth(req, res)) return;

    if (req.method === 'GET') {
      const [st, biz] = await Promise.all([
        supabase.from('user_passwords').select('must_change_pw').eq('user_key', 'owner').maybeSingle(),
        ensureBusiness().catch(() => null)
      ]);
      if (!biz) return res.json({ ok: false, error: 'ডাটাবেসে সংযোগ হচ্ছে না — schema.sql চালানো হয়েছে কিনা দেখুন' });
      return res.json({ ok: true, role: 'owner', userId: 'owner', today: bdtToday(), mustChangePw: !!(st.data && st.data.must_change_pw), business: bizOut(biz) });
    }

    if (req.method === 'POST' && d.action === 'verify') return res.json({ ok: await verifyOwnerPin(String(d.pin || '')) });

    if (req.method === 'POST' && (d.action === 'change' || d.action === 'first-set')) {
      const np = String(d.newPin || '').trim();
      if (!validPin(np)) return res.json({ ok: false, error: 'PIN অবশ্যই ৫ সংখ্যার হতে হবে' });
      if (np === '12345') return res.json({ ok: false, error: 'এই PIN সহজ — অন্য একটি দিন' });
      const { data } = await supabase.from('user_passwords').select('must_change_pw').eq('user_key', 'owner').maybeSingle();
      const forced = !!(data && data.must_change_pw);
      if (!(forced && d.action === 'first-set') && !(await verifyOwnerPin(String(d.oldPin || ''))))
        return res.json({ ok: false, error: 'বর্তমান PIN ভুল' });
      const { error } = await supabase.from('user_passwords').update({ password: hashPin(np), must_change_pw: false }).eq('user_key', 'owner');
      if (error) throw error;
      return res.json({ ok: true });
    }


    // ── rename the business / change its month cycle (there is only one; adding or deleting is not possible here) ──
    if (req.method === 'POST' && (d.action === 'biz-add' || d.action === 'biz-del'))
      return res.json({ ok: false, error: 'এই সংস্করণে শুধু একটি ব্যবসা চলে — যোগ বা মোছা যায় না' });
    if (req.method === 'POST' && d.action === 'biz-update') {
      const biz = await ensureBusiness();
      const patch = {};
      if (d.name !== undefined) { const n = str(d.name, 80); if (!n) return res.json({ ok: false, error: 'ব্যবসার নাম দিন' }); patch.name = n; }
      if (d.cycleDay !== undefined) { const day = cleanDay(d.cycleDay); if (day == null) return res.json({ ok: false, error: 'মাসের সাইকেল ১ থেকে ২৮ এর মধ্যে দিন' }); patch.cycle_start_day = day; }
      if (!Object.keys(patch).length) return res.json({ ok: false, error: 'কিছু বদলানো হয়নি' });
      const { data, error } = await rawSupabase.from('businesses').update(patch).eq('id', biz.id).select('id,name,cycle_start_day,created_at').maybeSingle();
      if (error) throw error;
      if (!data) return res.json({ ok: false, error: 'ব্যবসা পাওয়া যায়নি' });
      forgetBusiness();
      // first-run setup only: the name printed on memos starts as the business name (later edited separately in সেটিং)
      if (d.firstSetup === true && patch.name) await rawSupabase.from('app_settings').update({ shop_name: patch.name }).eq('business_id', biz.id);
      return res.json({ ok: true, business: bizOut(data) });
    }

    if (req.method === 'GET' && d.action === 'x') return res.json({ ok: false });
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) { res.json({ ok: false, error: safeErr(e) }); }
};
