// attendance.js — NEW FILE (AXIION blueprint §14 + §15)
// Punch in/out, live location ping + fetch, office-location geofence setup,
// reward/penalty calculation, Owner's monthly clear action.
//
// Rules implemented (confirmed with owner):
//  - Punch cutoff: on-time if punched at/before 08:30, else late.
//  - Daily on-time bonus: ৳20 per on-time day.
//  - Perfect-month bonus: ৳500 if on-time every working day (month minus Fridays).
//  - Late penalty: ৳500 deducted ONCE per month, the moment the 3rd late punch happens
//    (does not repeat for further late days that month).
//  - Applies to MANAGER and DSR only. SO staff can punch (for Owner visibility /
//    tracking only) but are excluded from bonus/penalty money calculations.
//  - Reward totals reset when Owner presses "Clear" (reward_ledger.cleared_at),
//    without deleting the underlying attendance history.

const { supabase, cors, now_, safeErr } = require('./_lib/db');

// Vercel serverless functions run in UTC, NOT Bangladesh time — using
// plain `new Date().getHours()` for the 08:30 cutoff was comparing against
// UTC wall-clock time, silently misjudging on-time/late. Every time-of-day
// or "which calendar day is it" decision below goes through these two
// Asia/Dhaka-aware helpers instead, so results are correct no matter what
// timezone the server process itself happens to run in.
const APP_TZ = 'Asia/Dhaka';

function _tzParts(d) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  const parts = {};
  fmt.formatToParts(d || new Date()).forEach(p => { if (p.type !== 'literal') parts[p.type] = p.value; });
  return parts; // { year, month, day, hour, minute }
}
function _tzISODate(d) {
  const p = _tzParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}
function _tzMinutesOfDay(d) {
  const p = _tzParts(d);
  return Number(p.hour) * 60 + Number(p.minute);
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  try {
    // ══════════════════════════════════════════════
    //  OFFICE LOCATION (geofence reference point)
    // ══════════════════════════════════════════════

    // POST ?action=office-set — Owner stands at the office and taps
    // "set office here"; the device's current GPS becomes the reference point.
    if (req.method === 'POST' && action === 'office-set') {
      const d = req.body || {};
      const lat = Number(d.lat), lng = Number(d.lng);
      if (!isFinite(lat) || !isFinite(lng))
        return res.json({ ok: false, error: 'লোকেশন পাওয়া যায়নি — GPS চালু আছে কিনা দেখুন' });
      const radiusM = Number(d.radiusM) || 150;
      const { error } = await supabase.from('office_location').upsert({
        id: 1, lat, lng, radius_m: radiusM,
        set_by: d.setBy || '', set_at: now_()
      }, { onConflict: 'id' });
      if (error) throw error;
      return res.json({ ok: true, office: { lat, lng, radiusM } });
    }

    // GET ?action=office-get
    if (req.method === 'GET' && action === 'office-get') {
      const { data, error } = await supabase.from('office_location').select('*').eq('id', 1).maybeSingle();
      if (error) throw error;
      return res.json({ ok: true, office: data ? mapOffice(data) : null });
    }

    // ══════════════════════════════════════════════
    //  PUNCH
    // ══════════════════════════════════════════════

    // POST ?action=punch
    if (req.method === 'POST' && action === 'punch') {
      const d = req.body || {};
      const userKey = String(d.userKey || '');
      if (!userKey) return res.json({ ok: false, error: 'ব্যবহারকারী পাওয়া যায়নি' });

      const nowD = new Date();
      const punchDate = _tzISODate(nowD);

      // already punched today? return existing, don't double-punch
      const { data: existing, error: exErr } = await supabase
        .from('attendance').select('*')
        .eq('user_key', userKey).eq('punch_date', punchDate).maybeSingle();
      if (exErr) throw exErr;
      if (existing) return res.json({ ok: true, already: true, record: mapAttendance(existing) });

      // ── Location check FIRST — if an office is configured, the punch
      // must physically be within its radius, otherwise it's rejected
      // outright (not just flagged for later review).
      const lat = d.lat != null ? Number(d.lat) : null;
      const lng = d.lng != null ? Number(d.lng) : null;
      const hasCoords = lat != null && lng != null && isFinite(lat) && isFinite(lng);

      const { data: office } = await supabase.from('office_location').select('*').eq('id', 1).maybeSingle();

      let atOffice = null, distanceM = null;
      if (office) {
        if (!hasCoords) {
          return res.json({ ok: false, error: '📍 লোকেশন পাওয়া যায়নি — GPS চালু করে আবার চেষ্টা করুন। অফিসে না থাকলে পাঞ্চ করা যাবে না।' });
        }
        distanceM = Math.round(_haversine(lat, lng, Number(office.lat), Number(office.lng)));
        atOffice = distanceM <= Number(office.radius_m || 150);
        if (!atOffice) {
          return res.json({
            ok: false,
            error: `⚠️ আপনি অফিস থেকে ${distanceM}মি দূরে আছেন — ${office.radius_m}মি এর মধ্যে থাকলে পাঞ্চ করতে পারবেন।`,
            distanceM, radiusM: Number(office.radius_m)
          });
        }
      }
      // If no office is configured yet, punch is allowed without a location
      // check (nothing to validate against) — Owner should set it up ASAP.

      const cutoffMin = 8 * 60 + 30; // 08:30 — evaluated in Asia/Dhaka time
      const nowMin = _tzMinutesOfDay(nowD);
      const status = nowMin <= cutoffMin ? 'present' : 'late';

      const row = {
        user_key:   userKey,
        user_name:  d.userName || '',
        role:       d.role || '',
        punch_date: punchDate,
        punch_time: now_(),
        status,
        lat, lng,
        at_office:  atOffice,
        distance_m: distanceM
      };
      const { error } = await supabase.from('attendance').insert(row);
      if (error) throw error;
      return res.json({ ok: true, already: false, record: mapAttendance(row) });
    }

    // GET ?action=punch-today&userKey=
    if (req.method === 'GET' && action === 'punch-today') {
      const userKey = req.query.userKey;
      const punchDate = _tzISODate(new Date());
      const { data, error } = await supabase
        .from('attendance').select('*')
        .eq('user_key', userKey).eq('punch_date', punchDate).maybeSingle();
      if (error) throw error;
      return res.json({ ok: true, record: data ? mapAttendance(data) : null });
    }

    // ══════════════════════════════════════════════
    //  LIVE LOCATION
    // ══════════════════════════════════════════════

    // POST ?action=location-ping — fired every ~90s while app is open
    if (req.method === 'POST' && action === 'location-ping') {
      const d = req.body || {};
      const lat = Number(d.lat), lng = Number(d.lng);
      if (!isFinite(lat) || !isFinite(lng)) return res.json({ ok: false, error: 'লোকেশন নেই' });
      const { error } = await supabase.from('live_locations').upsert({
        user_key:  String(d.userKey || ''),
        user_name: d.userName || '',
        role:      d.role || '',
        lat, lng,
        updated_at: now_()
      }, { onConflict: 'user_key' });
      if (error) throw error;
      return res.json({ ok: true });
    }

    // GET ?action=location-list&viewerRole=owner|manager
    if (req.method === 'GET' && action === 'location-list') {
      const viewerRole = req.query.viewerRole || '';
      let q = supabase.from('live_locations').select('*').order('updated_at', { ascending: false });
      if (viewerRole === 'manager') q = q.in('role', ['dsr', 'so']); // Manager sees DSR/SO only
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ ok: true, locations: (data || []).map(mapLoc) });
    }

    // ══════════════════════════════════════════════
    //  REWARDS / PENALTIES
    // ══════════════════════════════════════════════

    // GET ?action=reward-summary&userKey=&role=&month=YYYY-MM
    if (req.method === 'GET' && action === 'reward-summary') {
      const userKey = req.query.userKey || '';
      const role = req.query.role || '';
      const month = req.query.month || _tzISODate(new Date()).slice(0, 7);
      const r = await computeReward(userKey, role, month);
      return res.json({ ok: true, month, ...r });
    }

    // GET ?action=reward-list&month=YYYY-MM  (Owner: everyone at once)
    if (req.method === 'GET' && action === 'reward-list') {
      const month = req.query.month || _tzISODate(new Date()).slice(0, 7);
      const { data: staff, error } = await supabase
        .from('user_passwords').select('user_key,user_name,role')
        .in('role', ['manager', 'dsr', 'so']);
      if (error) throw error;
      const out = [];
      for (const s of (staff || [])) {
        const r = await computeReward(s.user_key, s.role, month);
        out.push({ userKey: s.user_key, userName: s.user_name, role: s.role, ...r });
      }
      return res.json({ ok: true, month, staff: out });
    }

    // POST ?action=reward-clear — Owner clears/pays out a user's running total
    if (req.method === 'POST' && action === 'reward-clear') {
      const d = req.body || {};
      const userKey = String(d.userKey || '');
      if (!userKey) return res.json({ ok: false, error: 'ব্যবহারকারী পাওয়া যায়নি' });
      const { error } = await supabase.from('reward_ledger').upsert({
        user_key: userKey, user_name: d.userName || '',
        cleared_at: now_(), updated_at: now_()
      }, { onConflict: 'user_key' });
      if (error) throw error;
      return res.json({ ok: true });
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};

// ══════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════

// Great-circle distance in meters
function _haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Pure calendar-date arithmetic (weekday-of-date, days-in-month) — built on
// Date.UTC so it is 100% independent of whatever timezone the server
// process itself happens to be running in. These never represent an actual
// moment in time, only "which weekday does calendar day D fall on".
function _daysInMonth(y, monthIdx) { return new Date(Date.UTC(y, monthIdx + 1, 0)).getUTCDate(); }
function _weekdayOf(y, monthIdx, day) { return new Date(Date.UTC(y, monthIdx, day)).getUTCDay(); }

// Days in month that are NOT Friday (Friday = weekly off-day)
function _workingDaysInMonth(y, monthIdx) {
  const days = _daysInMonth(y, monthIdx);
  let count = 0;
  for (let d = 1; d <= days; d++) if (_weekdayOf(y, monthIdx, d) !== 5) count++;
  return count;
}

// Day-of-month (integer) of the last working (non-Friday) day of the month
function _lastWorkingDayNum(y, monthIdx) {
  const days = _daysInMonth(y, monthIdx);
  for (let d = days; d >= 1; d--) if (_weekdayOf(y, monthIdx, d) !== 5) return d;
  return days;
}

async function computeReward(userKey, role, monthStr) {
  // SO: tracked for visibility only — never eligible for bonus/penalty money
  if (role === 'so') {
    return {
      excluded: true, onTimeCount: 0, lateCount: 0, dailyBonus: 0,
      perfectMonth: false, perfectBonus: 0, penalty: 0, total: 0,
      totalWorkingDays: 0, clearedAt: null
    };
  }

  const [y, m] = monthStr.split('-').map(Number);
  const monthStart = monthStr + '-01';
  const lastDay = new Date(y, m, 0).getDate();
  const monthEnd = monthStr + '-' + String(lastDay).padStart(2, '0');

  // If Owner cleared this user's reward earlier THIS month, only count
  // attendance strictly after the clear timestamp.
  const { data: ledger } = await supabase.from('reward_ledger').select('*').eq('user_key', userKey).maybeSingle();
  let clearedDateStr = null;
  if (ledger && ledger.cleared_at) {
    const cStr = new Date(ledger.cleared_at).toISOString().slice(0, 10);
    if (cStr >= monthStart && cStr <= monthEnd) clearedDateStr = cStr;
  }

  let q = supabase.from('attendance').select('*')
    .eq('user_key', userKey).gte('punch_date', monthStart).lte('punch_date', monthEnd);
  if (clearedDateStr) q = q.gt('punch_date', clearedDateStr);
  const { data: rows, error } = await q;
  if (error) throw error;

  const onTimeCount = (rows || []).filter(r => r.status === 'present').length;
  const lateCount    = (rows || []).filter(r => r.status === 'late').length;
  const dailyBonus   = onTimeCount * 20;

  const totalWorkingDays = _workingDaysInMonth(y, m - 1);
  const todayP = _tzParts(new Date()); // "today" in Asia/Dhaka, not server-local
  const todayY = Number(todayP.year), todayM = Number(todayP.month), todayD = Number(todayP.day);
  const lastWorkingDayNum = _lastWorkingDayNum(y, m - 1);
  const targetYM = y * 100 + m, todayYM = todayY * 100 + todayM;
  // A month only "concludes" once its last working day has passed in Dhaka
  // time (past months are always concluded; future months never are yet).
  const monthConcluded = targetYM < todayYM || (targetYM === todayYM && todayD >= lastWorkingDayNum);

  const perfectMonth = monthConcluded && lateCount === 0 && onTimeCount === totalWorkingDays;
  const perfectBonus = perfectMonth ? 500 : 0;
  // Once-only ৳500 penalty the moment the 3rd late punch happens (not repeated after)
  const penalty = lateCount >= 3 ? -500 : 0;
  const total = dailyBonus + perfectBonus + penalty;

  return {
    excluded: false, onTimeCount, lateCount, dailyBonus,
    perfectMonth, perfectBonus, penalty, total,
    totalWorkingDays, clearedAt: ledger ? ledger.cleared_at : null
  };
}

function mapOffice(r) {
  return { lat: Number(r.lat), lng: Number(r.lng), radiusM: Number(r.radius_m), setBy: r.set_by || '', setAt: r.set_at };
}
function mapLoc(r) {
  return { userKey: r.user_key, userName: r.user_name || '', role: r.role || '', lat: Number(r.lat), lng: Number(r.lng), updatedAt: r.updated_at };
}
function mapAttendance(r) {
  return {
    userKey: r.user_key, userName: r.user_name || '', role: r.role || '',
    punchDate: r.punch_date, punchTime: r.punch_time, status: r.status,
    lat: r.lat, lng: r.lng, atOffice: r.at_office, distanceM: r.distance_m
  };
}
