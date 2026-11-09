// v10 — the money the owner deposits to the company every day (online / bank transfer / cash).
//   GET    ?from=&to=        every day's entry in the range + totals by method   (default: the current month-cycle)
//   POST   {date, onlineAmt, bankAmt, cashAmt, note}   one entry per day — a day with nothing deposited is saved as 0
//   PUT    {id, …, pin}      correct an entry (owner PIN)
//   DELETE ?id=&pin=         remove an entry (owner PIN)
const { supabase, cors, str, safeErr, num, ds, today, fetchAll, auditLog, idemRun, _noTable, cyclePeriodBounds, cyclePeriodToday } = require('./_lib/db');
const { requireAuth, needPin, withBiz } = require('./_lib/auth');
const { r2 } = require('./_lib/money');
const { isPriv } = require('./_lib/profit');   // v14 role safety
const OWNER = { id: 'owner', role: 'owner' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX = 1e9;

const mapDep = (r) => {
  const o = r2(r.online_amt), b = r2(r.bank_amt), c = r2(r.cash_amt);
  return { id: String(r.id), date: ds(r.date), onlineAmt: o, bankAmt: b, cashAmt: c, total: r2(o + b + c), note: r.note || '', createdAt: r.created_at || '' };
};
const NO_TABLE = 'ডাটাবেসে v10 আপডেট (migrate-v10-offers-deposits.sql) এখনও চালানো হয়নি';

// amounts: blank → 0, never negative, never absurd
function amounts(d) {
  const f = (v) => r2(Math.max(0, num(v)));
  const o = { online_amt: f(d.onlineAmt), bank_amt: f(d.bankAmt), cash_amt: f(d.cashAmt) };
  if (o.online_amt > MAX || o.bank_amt > MAX || o.cash_amt > MAX) return null;
  return o;
}

module.exports = withBiz(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!isPriv(req)) return res.status(403).json({ ok: false, forbidden: true, error: 'এই অংশ শুধু মালিক ও ম্যানেজারের জন্য' });   // v14: deposits to the company are owner / manager only
  const q = req.query || {};
  try {
    if (req.method === 'GET') {
      let from = DATE_RE.test(q.from || '') ? q.from : '', to = DATE_RE.test(q.to || '') ? q.to : '';
      if (!from || !to) { const b = cyclePeriodBounds(cyclePeriodToday()); from = b.start; to = b.end; }
      if (from > to) { const t = from; from = to; to = t; }
      let rows;
      try { rows = await fetchAll(() => supabase.from('company_deposits').select('*').gte('date', from).lte('date', to), { tiebreak: 'date' }); }
      catch (e) { if (_noTable(e)) return res.json({ ok: false, error: NO_TABLE }); throw e; }
      const list = rows.map(mapDep).sort((a, b) => b.date.localeCompare(a.date));
      const sum = (k) => r2(list.reduce((s, x) => s + x[k], 0));
      return res.json({ ok: true, from, to, today: today(), deposits: list,
        totals: { online: sum('onlineAmt'), bank: sum('bankAmt'), cash: sum('cashAmt'), total: sum('total'), days: list.length, depositDays: list.filter(x => x.total > 0).length } });
    }

    if (req.method === 'POST') return idemRun(req, res, 'dep', async () => {
      const d = req.body || {};
      const date = DATE_RE.test(d.date || '') ? d.date : today();
      if (date > today()) return res.json({ ok: false, error: 'ভবিষ্যতের তারিখে জমা লেখা যাবে না' });
      const a = amounts(d); if (!a) return res.json({ ok: false, error: 'টাকার অঙ্ক ঠিক নেই' });
      const { data: ex, error: exErr } = await supabase.from('company_deposits').select('id').eq('date', date).limit(1);
      if (exErr) { if (_noTable(exErr)) return res.json({ ok: false, error: NO_TABLE }); throw exErr; }
      if (ex && ex.length) return res.json({ ok: false, already: true, error: date.split('-').reverse().join('/') + ' তারিখের জমা ইতিমধ্যে লেখা আছে — একদিনে একবারই লেখা যায়। ভুল হলে সেটি সংশোধন করুন।' });
      const { data, error } = await supabase.from('company_deposits').insert(Object.assign({ date, note: str(d.note, 300) }, a)).select().single();
      if (error) throw error;
      await auditLog(OWNER, 'create', 'company_deposits', data.id, null, data);
      res.json({ ok: true, deposit: mapDep(data) });
    });

    if (req.method === 'PUT') {
      const d = req.body || {};
      if (!(await needPin(req, res, d.pin))) return;
      const id = String(d.id || '');
      const { data: old } = await supabase.from('company_deposits').select('*').eq('id', id).maybeSingle();
      if (!old) return res.json({ ok: false, error: 'জমার রেকর্ড পাওয়া যায়নি' });
      const a = amounts(d); if (!a) return res.json({ ok: false, error: 'টাকার অঙ্ক ঠিক নেই' });
      const { data, error } = await supabase.from('company_deposits').update(Object.assign({ note: str(d.note, 300), updated_at: new Date().toISOString() }, a)).eq('id', id).select().single();
      if (error) throw error;
      await auditLog(OWNER, 'update', 'company_deposits', id, old, data);
      return res.json({ ok: true, deposit: mapDep(data) });
    }

    if (req.method === 'DELETE') {
      if (!(await needPin(req, res, q.pin))) return;
      const id = String(q.id || '');
      const { data: old } = await supabase.from('company_deposits').select('*').eq('id', id).maybeSingle();
      if (!old) return res.json({ ok: false, error: 'জমার রেকর্ড পাওয়া যায়নি' });
      const { error } = await supabase.from('company_deposits').delete().eq('id', id);
      if (error) throw error;
      await auditLog(OWNER, 'delete', 'company_deposits', id, old, null);
      return res.json({ ok: true });
    }
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) { res.json({ ok: false, error: safeErr(e) }); }
});
