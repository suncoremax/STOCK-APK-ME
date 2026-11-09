const { supabase, rawSupabase, cors, safeErr, bdtToday, str } = require('./_lib/db');
const { removeFromStorage } = require('./_lib/thumbStorage');
const { validPin, hashPin, signToken, requireAuth, verifyOwnerPin, forgetBusiness, UUID_RE } = require('./_lib/auth');

const SETUP_PIN = '12345';   // first-setup PIN — the app forces a change right after the first login
const crypto = require('crypto');
const samePin = (stored, pin) => { const a = Buffer.from(String(stored)), b = Buffer.from(hashPin(pin)); return a.length === b.length && crypto.timingSafeEqual(a, b); };

// ── businesses (one owner, many businesses; each business's data is completely separate) ──
const MAX_BUSINESSES = 20;
const bizOut = (r) => ({ id: String(r.id), name: r.name || '', cycleDay: r.cycle_start_day == null ? null : Number(r.cycle_start_day), createdAt: r.created_at || '' });
const cleanDay = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 28 ? n : null; };
async function listBusinesses() {
  const { data, error } = await rawSupabase.from('businesses').select('id,name,cycle_start_day,created_at').order('created_at');
  if (error) throw error;
  return (data || []).map(bizOut);
}
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
      const [probe, bizList] = await Promise.all([
        supabase.from('user_passwords').select('user_key,user_name,password,must_change_pw').eq('user_key', 'owner').maybeSingle(),
        listBusinesses().catch(() => null)   // fetched together with the PIN check: the business list then needs no extra request
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
      return res.json({ ok: true, role: 'owner', userId: 'owner', userName: (data && data.user_name) || 'Owner', token: signToken('owner'), mustChangePw: !!(data && data.must_change_pw), businesses: bizList || undefined });
    }
    // everything below needs a valid session
    if (!requireAuth(req, res)) return;

    if (req.method === 'GET') {
      const stP = supabase.from('user_passwords').select('must_change_pw').eq('user_key', 'owner').maybeSingle();
      let businesses = []; try { businesses = await listBusinesses(); } catch (e) { return res.json({ ok: false, error: 'ডাটাবেসে সংযোগ হচ্ছে না — schema.sql / migrate-v7-multi-business.sql চালানো হয়েছে কিনা দেখুন' }); }
      const { data: st } = await stP;
      return res.json({ ok: true, role: 'owner', userId: 'owner', today: bdtToday(), mustChangePw: !!(st && st.must_change_pw), businesses });
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


    // ── add / edit / delete a business ──
    if (req.method === 'POST' && d.action === 'biz-add') {
      if (!(await verifyOwnerPin(String(d.pin || '')))) return res.json({ ok: false, error: 'ভুল PIN — আবার চেষ্টা করুন' });
      const name = str(d.name, 80); if (!name) return res.json({ ok: false, error: 'ব্যবসার নাম দিন' });
      const day = cleanDay(d.cycleDay); if (day == null) return res.json({ ok: false, error: 'মাসের সাইকেল দিন — মাস কোন তারিখ থেকে শুরু (১ থেকে ২৮)' });
      const all = await listBusinesses();
      if (all.length >= MAX_BUSINESSES) return res.json({ ok: false, error: 'সর্বোচ্চ ' + MAX_BUSINESSES + 'টি ব্যবসা যোগ করা যায়' });
      if (all.some(b => b.name.toLowerCase() === name.toLowerCase())) return res.json({ ok: false, error: 'এই নামে আরেকটি ব্যবসা আছে — অন্য নাম দিন' });
      const ins = await rawSupabase.from('businesses').insert({ name, cycle_start_day: day }).select('id,name,cycle_start_day,created_at').single();
      if (ins.error) throw ins.error;
      const st = await rawSupabase.from('app_settings').insert({ business_id: ins.data.id, shop_name: name, shop_address: str(d.address, 200), shop_phone: str(d.phone, 40), distributor_name: str(d.ownerName, 100) });
      if (st.error) { await rawSupabase.from('businesses').delete().eq('id', ins.data.id); throw st.error; }
      forgetBusiness();
      return res.json({ ok: true, business: bizOut(ins.data) });
    }
    if (req.method === 'POST' && d.action === 'biz-update') {
      const id = String(d.id || ''); if (!UUID_RE.test(id)) return res.json({ ok: false, error: 'ব্যবসা পাওয়া যায়নি' });
      const patch = {};
      if (d.name !== undefined) { const n = str(d.name, 80); if (!n) return res.json({ ok: false, error: 'ব্যবসার নাম দিন' }); patch.name = n; }
      if (d.cycleDay !== undefined) { const day = cleanDay(d.cycleDay); if (day == null) return res.json({ ok: false, error: 'মাসের সাইকেল ১ থেকে ২৮ এর মধ্যে দিন' }); patch.cycle_start_day = day; }
      if (!Object.keys(patch).length) return res.json({ ok: false, error: 'কিছু বদলানো হয়নি' });
      const { data, error } = await rawSupabase.from('businesses').update(patch).eq('id', id).select('id,name,cycle_start_day,created_at').maybeSingle();
      if (error) throw error;
      if (!data) return res.json({ ok: false, error: 'ব্যবসা পাওয়া যায়নি' });
      forgetBusiness(id);
      return res.json({ ok: true, business: bizOut(data) });
    }
    if (req.method === 'POST' && d.action === 'biz-del') {
      if (!(await verifyOwnerPin(String(d.pin || '')))) return res.json({ ok: false, error: 'ভুল PIN — আবার চেষ্টা করুন' });
      const id = String(d.id || ''); if (!UUID_RE.test(id)) return res.json({ ok: false, error: 'ব্যবসা পাওয়া যায়নি' });
      const { data: thumbs } = await rawSupabase.from('products').select('thumb').eq('business_id', id);
      // every table of the business is removed with it (ON DELETE CASCADE)
      const { error } = await rawSupabase.from('businesses').delete().eq('id', id);
      if (error) throw error;
      forgetBusiness(id);
      for (const t of (thumbs || [])) if (t.thumb) await removeFromStorage(t.thumb);
      return res.json({ ok: true });
    }

    if (req.method === 'GET' && d.action === 'x') return res.json({ ok: false });
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) { res.json({ ok: false, error: safeErr(e) }); }
};
