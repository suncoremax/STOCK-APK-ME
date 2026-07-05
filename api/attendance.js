// attendance.js — REWRITTEN for the full Salary system
// (Punch In/Out, per-person attendance calendar, Owner-configurable
//  monthly salary + bonus scheme, day-override for forgotten punches)
//
// ── Punch rules ──────────────────────────────────────────────────────
//  - Morning punch ("in"): the day's 1st confirmation of presence.
//    On-time if at/before 08:30 (Asia/Dhaka), else late. Drives the
//    optional daily/perfect-month bonus (independent of salary).
//  - Evening punch ("out"): must happen between 18:00 today and 08:30
//    the NEXT calendar day. This is the day's 2nd confirmation.
//  - A day only counts toward SALARY if BOTH "in" and "out" exist for
//    that workday (regardless of whether the "in" was on-time or late),
//    OR the Owner manually approved that day via day-override (for a
//    forgotten punch).
//  - Fridays are the weekly off-day — never counted for salary or bonus,
//    in either direction.
//  - If an office location is configured, BOTH punches require GPS and
//    must be within the office radius, or they're rejected outright.
//
// ── Salary math ──────────────────────────────────────────────────────
//  - Owner sets a base monthly salary per person, per month (so a raise
//    only affects months from then on, past months stay untouched).
//  - dailyRate = baseSalary / workingDaysInMonth (month days minus Fridays)
//  - salaryEarned = dailyRate × validDays (days with both punches, or an override)
//  - Bonus is a separate optional toggle, per person, with owner-configurable
//    amounts (daily on-time bonus / perfect-month bonus / late penalty).
//  - Each month is tracked independently — an unpaid month just sits as
//    "due" for that specific month and never mixes into the next month.

const { supabase, cors, now_, safeErr } = require('./_lib/db');

// Vercel serverless functions run in UTC, not Bangladesh time — every
// time-of-day / "which calendar day is it" decision goes through these
// Asia/Dhaka-aware helpers so results are correct regardless of server TZ.
const APP_TZ = 'Asia/Dhaka';

function _tzParts(d) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  const parts = {};
  fmt.formatToParts(d || new Date()).forEach(p => { if (p.type !== 'literal') parts[p.type] = p.value; });
  return parts;
}
function _tzISODate(d) { const p = _tzParts(d); return `${p.year}-${p.month}-${p.day}`; }
function _tzMinutesOfDay(d) { const p = _tzParts(d); return Number(p.hour) * 60 + Number(p.minute); }

// Pure calendar-date arithmetic (weekday-of-date, days-in-month, add days)
// — built on Date.UTC so it's independent of the server process's own TZ.
function _daysInMonth(y, monthIdx) { return new Date(Date.UTC(y, monthIdx + 1, 0)).getUTCDate(); }
function _weekdayOf(y, monthIdx, day) { return new Date(Date.UTC(y, monthIdx, day)).getUTCDay(); }
function _workingDaysInMonth(y, monthIdx) {
  const days = _daysInMonth(y, monthIdx);
  let count = 0;
  for (let d = 1; d <= days; d++) if (_weekdayOf(y, monthIdx, d) !== 5) count++;
  return count;
}
function _lastWorkingDayNum(y, monthIdx) {
  const days = _daysInMonth(y, monthIdx);
  for (let d = days; d >= 1; d--) if (_weekdayOf(y, monthIdx, d) !== 5) return d;
  return days;
}
function _addDaysISO(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// Great-circle distance in meters
function _haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  try {
    // ══════════════════════════════════════════════
    //  OFFICE LOCATION (geofence reference point)
    // ══════════════════════════════════════════════

    if (req.method === 'POST' && action === 'office-set') {
      const d = req.body || {};
      const lat = Number(d.lat), lng = Number(d.lng);
      if (!isFinite(lat) || !isFinite(lng))
        return res.json({ ok: false, error: 'লোকেশন পাওয়া যায়নি — GPS চালু আছে কিনা দেখুন' });
      const radiusM = Number(d.radiusM) || 150;
      const { error } = await supabase.from('office_location').upsert({
        id: 1, lat, lng, radius_m: radiusM, set_by: d.setBy || '', set_at: now_()
      }, { onConflict: 'id' });
      if (error) throw error;
      return res.json({ ok: true, office: { lat, lng, radiusM } });
    }

    if (req.method === 'GET' && action === 'office-get') {
      const { data, error } = await supabase.from('office_location').select('*').eq('id', 1).maybeSingle();
      if (error) throw error;
      return res.json({ ok: true, office: data ? mapOffice(data) : null });
    }

    // ══════════════════════════════════════════════
    //  STAFF LIST (for Owner's person picker)
    // ══════════════════════════════════════════════

    if (req.method === 'GET' && action === 'staff-list') {
      const { data, error } = await supabase
        .from('user_passwords').select('user_key,user_name,role')
        .in('role', ['manager', 'dsr', 'so']);
      if (error) throw error;
      const staff = (data || []).sort((a, b) => (a.role + a.user_name).localeCompare(b.role + b.user_name));
      return res.json({ ok: true, staff });
    }

    // ══════════════════════════════════════════════
    //  PUNCH — in (morning) / out (evening checkout)
    // ══════════════════════════════════════════════

    if (req.method === 'POST' && action === 'punch') {
      const d = req.body || {};
      const userKey = String(d.userKey || '');
      if (!userKey) return res.json({ ok: false, error: 'ব্যবহারকারী পাওয়া যায়নি' });
      const punchType = d.punchType === 'out' ? 'out' : 'in';

      const nowD = new Date();
      const nowMin = _tzMinutesOfDay(nowD);
      const todayStr = _tzISODate(nowD);

      let workdayDate;
      if (punchType === 'in') {
        workdayDate = todayStr;
      } else {
        // checkout window: 18:00 today → 08:30 next day
        if (nowMin < 8 * 60 + 30) workdayDate = _addDaysISO(todayStr, -1); // tail end of yesterday's shift
        else if (nowMin >= 18 * 60) workdayDate = todayStr;
        else return res.json({ ok: false, error: '⏰ চেকআউট শুধুমাত্র সন্ধ্যা ৬টা থেকে পরদিন সকাল ৮:৩০ এর মধ্যে করা যায়' });
      }

      // already punched this type for this workday?
      const { data: existing, error: exErr } = await supabase
        .from('attendance').select('*')
        .eq('user_key', userKey).eq('punch_date', workdayDate).eq('punch_type', punchType).maybeSingle();
      if (exErr) throw exErr;
      if (existing) return res.json({ ok: true, already: true, record: mapAttendance(existing) });

      // Location check — required for BOTH in/out if an office is configured
      const lat = d.lat != null ? Number(d.lat) : null;
      const lng = d.lng != null ? Number(d.lng) : null;
      const hasCoords = lat != null && lng != null && isFinite(lat) && isFinite(lng);
      const { data: office } = await supabase.from('office_location').select('*').eq('id', 1).maybeSingle();

      let atOffice = null, distanceM = null;
      if (office) {
        if (!hasCoords) return res.json({ ok: false, error: '📍 লোকেশন পাওয়া যায়নি — GPS চালু করে আবার চেষ্টা করুন। অফিসে না থাকলে পাঞ্চ করা যাবে না।' });
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

      let status = null;
      if (punchType === 'in') {
        const cutoffMin = 8 * 60 + 30;
        status = nowMin <= cutoffMin ? 'present' : 'late';
      }

      const row = {
        user_key: userKey, user_name: d.userName || '', role: d.role || '',
        punch_date: workdayDate, punch_type: punchType, punch_time: now_(),
        status, lat, lng, at_office: atOffice, distance_m: distanceM
      };
      const { error } = await supabase.from('attendance').insert(row);
      if (error) throw error;
      return res.json({ ok: true, already: false, record: mapAttendance(row) });
    }

    // GET ?action=punch-today&userKey=  → today's in/out punch state
    if (req.method === 'GET' && action === 'punch-today') {
      const userKey = req.query.userKey;
      const todayStr = _tzISODate(new Date());
      const { data, error } = await supabase
        .from('attendance').select('*').eq('user_key', userKey).eq('punch_date', todayStr);
      if (error) throw error;
      const inRow  = (data || []).find(r => r.punch_type === 'in')  || null;
      const outRow = (data || []).find(r => r.punch_type === 'out') || null;
      return res.json({ ok: true, in: inRow ? mapAttendance(inRow) : null, out: outRow ? mapAttendance(outRow) : null });
    }

    // GET ?action=punch-state&userKey=  → full picture needed to decide
    // which button to show (Punch In / Punch Out), correctly accounting
    // for a checkout window that spans past midnight into "yesterday".
    if (req.method === 'GET' && action === 'punch-state') {
      const userKey = req.query.userKey;
      const nowD = new Date();
      const nowMin = _tzMinutesOfDay(nowD);
      const todayStr = _tzISODate(nowD);
      const yestStr = _addDaysISO(todayStr, -1);
      const checkoutWindowOpen = nowMin < 8 * 60 + 30 || nowMin >= 18 * 60;

      const { data, error } = await supabase
        .from('attendance').select('*').eq('user_key', userKey).in('punch_date', [todayStr, yestStr]);
      if (error) throw error;
      const find = (dateStr, type) => (data || []).find(r => r.punch_date === dateStr && r.punch_type === type) || null;
      const todayIn = find(todayStr, 'in'), todayOut = find(todayStr, 'out');
      const yestIn  = find(yestStr, 'in'),  yestOut  = find(yestStr, 'out');
      const needsCheckout = checkoutWindowOpen && ((todayIn && !todayOut) || (yestIn && !yestOut));

      return res.json({
        ok: true, checkoutWindowOpen, needsCheckout,
        todayDate: todayStr,
        todayIn: todayIn ? mapAttendance(todayIn) : null,
        todayOut: todayOut ? mapAttendance(todayOut) : null,
        yestDate: yestStr,
        yestIn: yestIn ? mapAttendance(yestIn) : null,
        yestOut: yestOut ? mapAttendance(yestOut) : null
      });
    }

    // ══════════════════════════════════════════════
    //  LIVE LOCATION
    // ══════════════════════════════════════════════

    if (req.method === 'POST' && action === 'location-ping') {
      const d = req.body || {};
      const lat = Number(d.lat), lng = Number(d.lng);
      if (!isFinite(lat) || !isFinite(lng)) return res.json({ ok: false, error: 'লোকেশন নেই' });
      const { error } = await supabase.from('live_locations').upsert({
        user_key: String(d.userKey || ''), user_name: d.userName || '', role: d.role || '',
        lat, lng, updated_at: now_()
      }, { onConflict: 'user_key' });
      if (error) throw error;
      return res.json({ ok: true });
    }

    if (req.method === 'GET' && action === 'location-list') {
      const viewerRole = req.query.viewerRole || '';
      let q = supabase.from('live_locations').select('*').order('updated_at', { ascending: false });
      if (viewerRole === 'manager') q = q.in('role', ['dsr', 'so']);
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ ok: true, locations: (data || []).map(mapLoc) });
    }

    // ══════════════════════════════════════════════
    //  PER-PERSON ATTENDANCE CALENDAR
    // ══════════════════════════════════════════════

    // GET ?action=calendar&userKey=&month=YYYY-MM
    if (req.method === 'GET' && action === 'calendar') {
      const userKey = req.query.userKey;
      const month = req.query.month || _tzISODate(new Date()).slice(0, 7);
      const [y, m] = month.split('-').map(Number);
      const lastDay = _daysInMonth(y, m - 1);
      const monthStart = month + '-01', monthEnd = month + '-' + String(lastDay).padStart(2, '0');

      const [attRes, ovrRes] = await Promise.all([
        supabase.from('attendance').select('*').eq('user_key', userKey).gte('punch_date', monthStart).lte('punch_date', monthEnd),
        supabase.from('salary_day_override').select('*').eq('user_key', userKey).gte('workday_date', monthStart).lte('workday_date', monthEnd)
      ]);
      if (attRes.error) throw attRes.error;
      if (ovrRes.error) throw ovrRes.error;

      const byDate = {};
      (attRes.data || []).forEach(r => { if (!byDate[r.punch_date]) byDate[r.punch_date] = {}; byDate[r.punch_date][r.punch_type] = r; });
      const overrideMap = {};
      (ovrRes.data || []).forEach(r => { overrideMap[r.workday_date] = { reason: r.reason || '', approvedBy: r.approved_by || '', approvedAt: r.approved_at }; });

      const todayStr = _tzISODate(new Date());
      const days = {};
      for (let day = 1; day <= lastDay; day++) {
        const dateStr = month + '-' + String(day).padStart(2, '0');
        const isFriday = _weekdayOf(y, m - 1, day) === 5;
        const rec = byDate[dateStr] || {};
        const hasIn = !!rec.in, hasOut = !!rec.out;
        const override = overrideMap[dateStr] || null;
        days[dateStr] = {
          isFriday,
          isFuture: dateStr > todayStr,
          hasIn, hasOut,
          inStatus: rec.in ? rec.in.status : null,
          inTime:   rec.in ? rec.in.punch_time : null,
          outTime:  rec.out ? rec.out.punch_time : null,
          inAtOffice: rec.in ? rec.in.at_office : null,
          outAtOffice: rec.out ? rec.out.at_office : null,
          override: !!override,
          overrideReason: override ? override.reason : null,
          salaryValid: !isFriday && !!(override || (hasIn && hasOut))
        };
      }
      return res.json({ ok: true, month, days });
    }

    // POST ?action=day-override — Owner manually approves a missed-punch day
    if (req.method === 'POST' && action === 'day-override') {
      const d = req.body || {};
      const userKey = String(d.userKey || ''), workdayDate = String(d.workdayDate || '');
      if (!userKey || !/^\d{4}-\d{2}-\d{2}$/.test(workdayDate)) return res.json({ ok: false, error: 'ভুল ইনপুট' });
      const { error } = await supabase.from('salary_day_override').upsert({
        user_key: userKey, workday_date: workdayDate,
        reason: d.reason || '', approved_by: d.approvedBy || '', approved_at: now_()
      }, { onConflict: 'user_key,workday_date' });
      if (error) throw error;
      return res.json({ ok: true });
    }

    // ══════════════════════════════════════════════
    //  SALARY
    // ══════════════════════════════════════════════

    // GET ?action=salary-summary&userKey=&month=YYYY-MM
    if (req.method === 'GET' && action === 'salary-summary') {
      const userKey = req.query.userKey;
      const month = req.query.month || _tzISODate(new Date()).slice(0, 7);
      const r = await computeSalary(userKey, month);
      return res.json({ ok: true, month, ...r });
    }

    // POST ?action=salary-set — Owner fixes base salary + bonus scheme for a person/month
    if (req.method === 'POST' && action === 'salary-set') {
      const d = req.body || {};
      const userKey = String(d.userKey || ''), month = String(d.month || '');
      if (!userKey || !/^\d{4}-\d{2}$/.test(month)) return res.json({ ok: false, error: 'ভুল ইনপুট' });
      const row = {
        user_key: userKey, month, user_name: d.userName || '',
        base_salary: Number(d.baseSalary) || 0,
        bonus_enabled: !!d.bonusEnabled,
        daily_bonus_amt: Number(d.dailyBonusAmt) || 0,
        perfect_bonus_amt: Number(d.perfectBonusAmt) || 0,
        late_penalty_amt: Number(d.latePenaltyAmt) || 0,
        set_by: d.setBy || '', set_at: now_()
      };
      const { error } = await supabase.from('salary_settings').upsert(row, { onConflict: 'user_key,month' });
      if (error) throw error;
      return res.json({ ok: true });
    }

    // POST ?action=salary-pay — Owner marks a specific month's salary as paid
    if (req.method === 'POST' && action === 'salary-pay') {
      const d = req.body || {};
      const userKey = String(d.userKey || ''), month = String(d.month || '');
      if (!userKey || !/^\d{4}-\d{2}$/.test(month)) return res.json({ ok: false, error: 'ভুল ইনপুট' });
      const { error } = await supabase.from('salary_ledger').upsert({
        user_key: userKey, month, user_name: d.userName || '',
        paid_at: now_(), paid_amount: Number(d.amount) || 0, paid_by: d.paidBy || '', updated_at: now_()
      }, { onConflict: 'user_key,month' });
      if (error) throw error;
      return res.json({ ok: true });
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};

// ══════════════════════════════════════════════════
//  SALARY CALCULATION
// ══════════════════════════════════════════════════

async function _getSalarySettings(userKey, month) {
  const { data: exact } = await supabase.from('salary_settings').select('*').eq('user_key', userKey).eq('month', month).maybeSingle();
  if (exact) return { ...mapSalarySettings(exact), inherited: false };
  const { data: prior } = await supabase.from('salary_settings').select('*')
    .eq('user_key', userKey).lt('month', month).order('month', { ascending: false }).limit(1);
  if (prior && prior.length) return { ...mapSalarySettings(prior[0]), inherited: true };
  return null; // Owner has never configured a salary for this person
}

async function computeSalary(userKey, month) {
  const [y, m] = month.split('-').map(Number);
  const lastDay = _daysInMonth(y, m - 1);
  const monthStart = month + '-01', monthEnd = month + '-' + String(lastDay).padStart(2, '0');

  const settings = await _getSalarySettings(userKey, month);
  const workingDays = _workingDaysInMonth(y, m - 1);
  const dailyRate = settings && workingDays > 0 ? settings.baseSalary / workingDays : 0;

  const [attRes, ovrRes, ledgerRes] = await Promise.all([
    supabase.from('attendance').select('*').eq('user_key', userKey).gte('punch_date', monthStart).lte('punch_date', monthEnd),
    supabase.from('salary_day_override').select('workday_date').eq('user_key', userKey).gte('workday_date', monthStart).lte('workday_date', monthEnd),
    supabase.from('salary_ledger').select('*').eq('user_key', userKey).eq('month', month).maybeSingle()
  ]);
  if (attRes.error) throw attRes.error;
  if (ovrRes.error) throw ovrRes.error;

  const byDate = {};
  (attRes.data || []).forEach(r => { if (!byDate[r.punch_date]) byDate[r.punch_date] = {}; byDate[r.punch_date][r.punch_type] = r; });
  const overrideDates = new Set((ovrRes.data || []).map(r => r.workday_date));

  let validDays = 0, onTimeCount = 0, lateCount = 0;
  for (let day = 1; day <= lastDay; day++) {
    if (_weekdayOf(y, m - 1, day) === 5) continue; // Friday — never counted either way
    const dateStr = month + '-' + String(day).padStart(2, '0');
    const rec = byDate[dateStr] || {};
    if (rec.in && rec.in.status === 'present') onTimeCount++;
    if (rec.in && rec.in.status === 'late') lateCount++;
    if (overrideDates.has(dateStr) || (rec.in && rec.out)) validDays++;
  }

  const salaryEarned = Math.round(dailyRate * validDays * 100) / 100;

  let dailyBonus = 0, perfectBonus = 0, penalty = 0, perfectMonth = false, bonus = 0;
  const bonusEnabled = !!(settings && settings.bonusEnabled);
  if (bonusEnabled) {
    dailyBonus = onTimeCount * settings.dailyBonusAmt;
    const todayP = _tzParts(new Date());
    const todayY = Number(todayP.year), todayM = Number(todayP.month), todayD = Number(todayP.day);
    const lastWorkingDayNum = _lastWorkingDayNum(y, m - 1);
    const targetYM = y * 100 + m, todayYM = todayY * 100 + todayM;
    const monthConcluded = targetYM < todayYM || (targetYM === todayYM && todayD >= lastWorkingDayNum);
    perfectMonth = monthConcluded && lateCount === 0 && onTimeCount === workingDays;
    perfectBonus = perfectMonth ? settings.perfectBonusAmt : 0;
    penalty = lateCount >= 3 ? -settings.latePenaltyAmt : 0;
    bonus = dailyBonus + perfectBonus + penalty;
  }

  const total = salaryEarned + bonus;
  const ledger = ledgerRes.data || null;

  return {
    settings, workingDays, dailyRate: Math.round(dailyRate * 100) / 100, validDays,
    salaryEarned, bonusEnabled, onTimeCount, lateCount, dailyBonus, perfectMonth, perfectBonus, penalty, bonus,
    total, paid: !!(ledger && ledger.paid_at), paidAmount: ledger ? Number(ledger.paid_amount) : 0, paidAt: ledger ? ledger.paid_at : null
  };
}

// ══════════════════════════════════════════════════
//  MAPPERS
// ══════════════════════════════════════════════════

function mapOffice(r) {
  return { lat: Number(r.lat), lng: Number(r.lng), radiusM: Number(r.radius_m), setBy: r.set_by || '', setAt: r.set_at };
}
function mapLoc(r) {
  return { userKey: r.user_key, userName: r.user_name || '', role: r.role || '', lat: Number(r.lat), lng: Number(r.lng), updatedAt: r.updated_at };
}
function mapAttendance(r) {
  return {
    userKey: r.user_key, userName: r.user_name || '', role: r.role || '',
    punchDate: r.punch_date, punchType: r.punch_type, punchTime: r.punch_time, status: r.status,
    lat: r.lat, lng: r.lng, atOffice: r.at_office, distanceM: r.distance_m
  };
}
function mapSalarySettings(r) {
  return {
    month: r.month, baseSalary: Number(r.base_salary), bonusEnabled: !!r.bonus_enabled,
    dailyBonusAmt: Number(r.daily_bonus_amt), perfectBonusAmt: Number(r.perfect_bonus_amt),
    latePenaltyAmt: Number(r.late_penalty_amt), setBy: r.set_by || '', setAt: r.set_at
  };
}
