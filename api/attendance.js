// api/attendance.js
// Blueprint §14 (Location Tracking) + §15 (Attendance Punch, Rewards & Penalties)
//
// Rules encoded here (confirmed with owner before building):
//  - Manager, DSR, and SO can all punch in / send location pings.
//  - Only Manager and DSR earn reward/penalty money. SO is tracked for
//    visibility only — reward-summary is simply never called for SO by the
//    frontend, but the punch/location endpoints treat all three the same.
//  - On-time cutoff: 8:30 AM Asia/Dhaka (UTC+6, no DST).
//  - Daily on-time bonus: +৳20.
//  - Perfect-month bonus: +৳500, only once the month's working days
//    (all days except Friday) have fully elapsed and every single one of
//    them was punched on-time (zero late days that period).
//  - Late penalty: a flat -৳500 the moment lateDays >= 3 in the period —
//    ONE-TIME per period, not repeated for every late day after the 3rd.
//  - "Clear" stamps cleared_at on reward_ledger; it does not delete
//    attendance history — future totals for that period only count
//    attendance rows after that timestamp.

const {
  supabase, cors, num, str, safeErr,
  dhakaParts, countWorkingDays,
  mapAttendance, mapLiveLoc
} = require('./_lib/db');

function periodBounds(period) {
  // period = 'YYYY-MM'
  const start = period + '-01';
  const y = Number(period.slice(0, 4)), m = Number(period.slice(5, 7));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = period + '-' + String(lastDay).padStart(2, '0');
  return { start, end };
}

async function computeReward(userKey, period) {
  const { start, end } = periodBounds(period);
  const todayDhaka = dhakaParts().dateStr;
  const currentPeriod = todayDhaka.slice(0, 7);

  // Cursor: has the owner cleared this user's reward for this period already?
  const { data: rl } = await supabase
    .from('reward_ledger').select('*')
    .eq('user_key', userKey).eq('period', period).maybeSingle();
  const clearedAt = rl && rl.cleared ? rl.cleared_at : null;
  const clearedDateStr = clearedAt ? String(clearedAt).slice(0, 10) : null;

  const effectiveStart = clearedDateStr && clearedDateStr > start
    ? clearedDateStr // same-day rows after the clear moment still count via punch_time filter below
    : start;

  // referenceEnd: for the current month, only "up to today"; for a past
  // (already-closed) month, the whole month.
  const referenceEnd = period === currentPeriod ? todayDhaka : end;
  const isPeriodComplete = referenceEnd >= end;

  let q = supabase.from('attendance').select('*')
    .eq('user_key', userKey)
    .gte('punch_date', effectiveStart)
    .lte('punch_date', referenceEnd)
    .order('punch_date');
  const { data: rowsRaw } = await q;
  let rows = (rowsRaw || []).map(mapAttendance);
  if (clearedAt) rows = rows.filter(r => new Date(r.punchTime) > new Date(clearedAt));

  const onTimeDays = rows.filter(r => r.status === 'present').length;
  const lateDays = rows.filter(r => r.status === 'late').length;

  const workingDaysElapsed = countWorkingDays(effectiveStart, referenceEnd);
  const workingDaysTotal = countWorkingDays(effectiveStart, end);

  const bonusTotal = onTimeDays * 20;
  const penaltyTotal = lateDays >= 3 ? 500 : 0;
  const perfectMonth = isPeriodComplete && workingDaysElapsed > 0 &&
    lateDays === 0 && onTimeDays === workingDaysElapsed;
  const perfectBonus = perfectMonth ? 500 : 0;
  const netTotal = bonusTotal + perfectBonus - penaltyTotal;

  return {
    userKey, period,
    onTimeDays, lateDays,
    workingDaysElapsed, workingDaysTotal,
    bonusTotal, penaltyTotal, perfectMonth, perfectBonus, netTotal,
    cleared: !!(rl && rl.cleared), clearedAt: clearedAt || ''
  };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const action = (req.method === 'GET' ? req.query.action : (req.query.action || (req.body || {}).action));

    // ══════════════════════════════════════════════════
    //  POST ?action=punch
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'punch') {
      const b = req.body || {};
      const userKey = str(b.userKey, 100);
      const userName = str(b.userName, 100);
      const role = str(b.role, 20);
      if (!userKey || !['manager', 'dsr', 'so'].includes(role)) {
        return res.json({ ok: false, error: 'userKey ও role আবশ্যক' });
      }
      const parts = dhakaParts();
      const punchDate = parts.dateStr;

      const { data: existing } = await supabase.from('attendance')
        .select('*').eq('user_key', userKey).eq('punch_date', punchDate).maybeSingle();
      if (existing) {
        return res.json({ ok: true, already: true, attendance: mapAttendance(existing) });
      }

      const status = (parts.hh < 8 || (parts.hh === 8 && parts.mm <= 30)) ? 'present' : 'late';
      const lat = b.lat != null && b.lat !== '' ? num(b.lat) : null;
      const lng = b.lng != null && b.lng !== '' ? num(b.lng) : null;

      const { data: inserted, error } = await supabase.from('attendance').insert({
        user_key: userKey, user_name: userName, role,
        punch_date: punchDate, status, lat, lng
      }).select().single();
      if (error) throw error;

      return res.json({ ok: true, already: false, attendance: mapAttendance(inserted) });
    }

    // ══════════════════════════════════════════════════
    //  POST ?action=location-ping
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'location-ping') {
      const b = req.body || {};
      const userKey = str(b.userKey, 100);
      const role = str(b.role, 20);
      if (!userKey || !['manager', 'dsr', 'so'].includes(role)) {
        return res.json({ ok: false, error: 'userKey ও role আবশ্যক' });
      }
      const lat = num(b.lat), lng = num(b.lng);
      const { error } = await supabase.from('live_locations').upsert({
        user_key: userKey, user_name: str(b.userName, 100), role,
        lat, lng, updated_at: new Date().toISOString()
      }, { onConflict: 'user_key' });
      if (error) throw error;
      return res.json({ ok: true });
    }

    // ══════════════════════════════════════════════════
    //  GET ?action=location-list&requesterRole=owner|manager
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'location-list') {
      const requesterRole = str(req.query.requesterRole, 20);
      const { data } = await supabase.from('live_locations').select('*').order('updated_at', { ascending: false });
      let list = (data || []).map(mapLiveLoc);
      if (requesterRole === 'manager') list = list.filter(l => l.role === 'dsr' || l.role === 'so');
      return res.json({ ok: true, locations: list });
    }

    // ══════════════════════════════════════════════════
    //  GET ?action=reward-summary&userKey=&period=
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'reward-summary') {
      const userKey = str(req.query.userKey, 100);
      if (!userKey) return res.json({ ok: false, error: 'userKey আবশ্যক' });
      const period = str(req.query.period, 7) || dhakaParts().dateStr.slice(0, 7);
      const summary = await computeReward(userKey, period);
      return res.json({ ok: true, summary });
    }

    // ══════════════════════════════════════════════════
    //  GET ?action=reward-summary-all&period=
    //  Owner/Manager overview — Manager + every DSR (SO excluded, no reward)
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'reward-summary-all') {
      const period = str(req.query.period, 7) || dhakaParts().dateStr.slice(0, 7);
      const { data: dsrRows } = await supabase.from('srs').select('id,name,role').eq('role', 'dsr').order('created_at');
      const people = [{ userKey: 'manager', userName: 'Manager' }]
        .concat((dsrRows || []).map(r => ({ userKey: String(r.id), userName: r.name || '' })));
      const summaries = await Promise.all(people.map(async p => {
        const s = await computeReward(p.userKey, period);
        return { ...s, userName: p.userName };
      }));
      return res.json({ ok: true, period, summaries });
    }

    // ══════════════════════════════════════════════════
    //  POST ?action=reward-clear   { userKey, period }
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'reward-clear') {
      const b = req.body || {};
      const userKey = str(b.userKey, 100);
      const period = str(b.period, 7) || dhakaParts().dateStr.slice(0, 7);
      if (!userKey) return res.json({ ok: false, error: 'userKey আবশ্যক' });
      const { error } = await supabase.from('reward_ledger').upsert({
        user_key: userKey, user_name: str(b.userName, 100), period,
        cleared: true, cleared_at: new Date().toISOString()
      }, { onConflict: 'user_key,period' });
      if (error) throw error;
      return res.json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
