// claims.js — merged bonus.js + damage.js, routed by ?type=bonus | ?type=damage
//
// V44 updates #13/#14: the old owner-facing "পেয়েছি / পরিশোধিত" controls
// (mark-as-paid, which instantly reset the whole running total to zero
// for a product) are GONE from this file entirely — POST is no longer
// accepted here. In their place, GET now takes an optional date range
// (?from=YYYY-MM-DD&to=YYYY-MM-DD) and returns bonus/damage figures for
// exactly that window, computed live every time from raw records — no
// state is ever written or reset by viewing a report. Leaving off
// from/to defaults to the CURRENT pay cycle (V41 update #7's 26th→25th
// window), so the figures naturally reset each cycle just by looking —
// no manual action required, per update #14.
const {
  supabase, cors, num, ds, str, today, now_, mapDmg, safeErr, auditLog, idemRun, _noTable,
  cyclePeriodBounds, cyclePeriodToday, cyclePeriodForDate, computeBonusRangeSummary, fetchAll
} = require('./_lib/db');
const { requireAuth, needPin, withBiz } = require('./_lib/auth');
const { r2 } = require('./_lib/money');
const { handleOffer } = require('./_lib/offerHandler');
const { isPriv } = require('./_lib/profit');   // v13 — company offer ledger (owner / manager only)

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-\d{2}$/;

// Resolves the from/to query params to a valid [from,to] range, falling
// back to the current pay-cycle bounds when missing/invalid, and
// swapping the two if given in reverse order.
// V48 update #46 — also accepts ?period=YYYY-MM directly (the "which
// month cycle" label used everywhere else per update #7), so the
// Monthly Damage Report can ask for a specific pay-cycle by name instead
// of hand-computing its from/to dates on the client.
function _resolveRange(req) {
  const period = (req.query && req.query.period) || '';
  if (PERIOD_RE.test(period)) {
    const b = cyclePeriodBounds(period);
    return { from: b.start, to: b.end };
  }
  let from = (req.query && req.query.from) || '';
  let to   = (req.query && req.query.to)   || '';
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    const b = cyclePeriodBounds(cyclePeriodToday());
    from = b.start; to = b.end;
  }
  if (from > to) { const t = from; from = to; to = t; }
  return { from, to };
}

module.exports = withBiz(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const type = (req.query && req.query.type) || '';

  try {
    if (type === 'offer') return await handleOffer(req, res);   // v13 — কোম্পানি অফার হিসাব: ?type=offer&action=ledger|report|pay-add|pay-edit|pay-del
    if (['receivable', 'receive', 'receipt', 'bonus'].includes(type) && !isPriv(req)) return res.status(403).json({ ok: false, forbidden: true, error: 'এই অংশ শুধু মালিক ও ম্যানেজারের জন্য' });   // v14 role safety
    if (type === 'receivable' && req.method === 'GET') return await handleReceivable(req, res);   // v10 — what the company still owes us
    if (type === 'receive' && req.method === 'POST') return await handleReceive(req, res);      // v10 — the company paid: "পেয়েছি"
    if (type === 'receipt' && req.method === 'DELETE') return await handleUndoReceipt(req, res);
    if (type === 'bonus') return await handleBonus(req, res);
    if (type === 'damage') return await handleDamage(req, res);
    return res.json({ ok: false, error: 'type=bonus বা type=damage প্রয়োজন' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
});

// ══════════════════════════════════════════════════
//  BONUS — GET only. Pure date-range view (updates #13/#14).
// ══════════════════════════════════════════════════
async function handleBonus(req, res) {
  if (req.method === 'GET') {
    const { from, to } = _resolveRange(req);
    const byProduct = await computeBonusRangeSummary(from, to);
    const totalAmount = byProduct.reduce((s, b) => s + num(b.amount), 0);
    return res.json({ ok: true, from, to, generatedAt: now_(), totalAmount, byProduct });
  }
  res.status(405).json({ ok: false, error: 'এই রিপোর্ট এখন শুধু দেখার জন্য — POST সমর্থিত নয়' });
}

// ══════════════════════════════════════════════════
//  DAMAGE — GET only. Pure date-range view (updates #13/#14).
//  Status (pending/cleared) is intentionally ignored for these totals —
//  every claim dated inside the chosen range counts, so nothing needs
//  to be manually "cleared" just to be seen in a report.
// ══════════════════════════════════════════════════
async function handleDamage(req, res) {
  if (req.method === 'GET') {
    const { from, to } = _resolveRange(req);
    const [dmgRes, prodRes] = await Promise.all([
      fetchAll(() => supabase.from('dmg_claims').select('*').gte('date', from).lte('date', to).order('date')).then(d => ({ data: d, error: null })),
      // Update #46 — case_size pulled alongside thumb so the Monthly
      // Damage Report can print "X কেস Y পিস" per SKU, not just a raw
      // piece total, matching the case+piece rule used everywhere else.
      supabase.from('products').select('id,thumb,case_size')
    ]);
    if (dmgRes.error) throw dmgRes.error;
    const claims = (dmgRes.data || []).map(mapDmg);
    const prodMetaMap = {};
    (prodRes.data || []).forEach(p => { prodMetaMap[String(p.id)] = { thumb: p.thumb || '', caseSize: Number(p.case_size) || 1 }; });

    const map = {};
    claims.forEach(c => {
      const pid = c.productId; if (!pid) return;
      if (!map[pid]) map[pid] = {
        productId: pid, name: c.productName, sku: c.sku,
        thumb: (prodMetaMap[pid] || {}).thumb || '',
        caseSize: (prodMetaMap[pid] || {}).caseSize || 1,
        units: 0, cost: 0
      };
      map[pid].units += num(c.totalUnits);
      map[pid].cost  += num(c.totalCost);
    });
    // Update #46 — one row per damaged SKU: case count, piece count,
    // total quantity (units), and buying price (weighted-average
    // purchase rate = this window's cost ÷ units, so it stays accurate
    // even if the product's purchase price changed mid-window).
    const byProduct = Object.values(map).map(p => {
      const cs = p.caseSize || 1;
      const cases = Math.floor(p.units / cs);
      const pieces = +(p.units - cases * cs).toFixed(2);
      const buyingPrice = p.units > 0 ? +(p.cost / p.units).toFixed(4) : 0;
      return { ...p, cases, pieces, totalQuantity: p.units, buyingPrice };
    }).sort((a, b) => b.cost - a.cost);
    const totalCost  = byProduct.reduce((s, p) => s + p.cost, 0);
    const totalUnits = byProduct.reduce((s, p) => s + p.units, 0);
    // v5.4 — total quantity as exact cases + loose pieces (never a bare piece total)
    const totalCP = { cases: byProduct.reduce((s, p) => s + p.cases, 0), pcs: byProduct.reduce((s, p) => s + Math.round(p.pieces), 0) };
    return res.json({ ok: true, from, to, generatedAt: now_(), totalCost, totalUnits, totalCP, byProduct });
  }
  res.status(405).json({ ok: false, error: 'এই রিপোর্ট এখন শুধু দেখার জন্য — POST সমর্থিত নয়' });
}


// ══════════════════════════════════════════════════
//  v10 — RECEIVABLE FROM THE COMPANY (bonus / free offer + damage claims)
//  Earned per month-cycle (computed live) minus what the owner has marked "পেয়েছি" (company_receipts).
//  Only the money marked as received counts in profit; the rest is a virtual receivable.
// ══════════════════════════════════════════════════
function prevPeriod(p) { let [y, m] = p.split('-').map(Number); m--; if (m < 1) { m = 12; y--; } return y + '-' + String(m).padStart(2, '0'); }
const mapReceipt = (r) => ({ id: String(r.id), kind: r.kind, period: r.period, from: ds(r.from_date), to: ds(r.to_date), amount: num(r.amount), date: ds(r.received_date), note: r.note || '', createdAt: r.created_at || '' });
const PERIOD_MAX = 18;

async function handleReceivable(req, res) {
  const cur = cyclePeriodToday();
  const { data: first } = await supabase.from('transactions').select('date').in('type', ['give', 'point_sale', 'damage']).order('date', { ascending: true }).limit(1);
  const firstP = first && first[0] ? cyclePeriodForDate(ds(first[0].date)) : cur;
  const periods = []; let pp = cur;
  for (let i = 0; i < PERIOD_MAX; i++) { periods.push(pp); if (pp <= firstP) break; pp = prevPeriod(pp); }
  const lo = cyclePeriodBounds(periods[periods.length - 1]).start, hi = cyclePeriodBounds(cur).end;

  let receipts = [], ready = true;
  try { receipts = await fetchAll(() => supabase.from('company_receipts').select('*')); }
  catch (e) { if (_noTable(e)) ready = false; else throw e; }
  const prodsRaw = await fetchAll(() => supabase.from('products').select('*').order('created_at'));
  const [bonusAll, dmgRows] = await Promise.all([
    Promise.all(periods.map(p => { const b = cyclePeriodBounds(p); return computeBonusRangeSummary(b.start, b.end, prodsRaw); })),
    fetchAll(() => supabase.from('dmg_claims').select('date,total_cost,total_units,product_name').gte('date', lo).lte('date', hi))
  ]);

  const rc = {}; receipts.forEach(r => { const k = r.kind + '|' + r.period; rc[k] = (rc[k] || 0) + num(r.amount); });
  const dmgBy = {};
  dmgRows.forEach(c => {
    const p = cyclePeriodForDate(ds(c.date)), o = dmgBy[p] || (dmgBy[p] = { cost: 0, units: 0, items: {} });
    o.cost += num(c.total_cost); o.units += num(c.total_units);
    const n = c.product_name || '—'; o.items[n] = (o.items[n] || 0) + num(c.total_cost);
  });

  const months = [];
  const tot = { bonusPending: 0, damagePending: 0, bonusRunning: 0, damageRunning: 0, bonusPast: 0, damagePast: 0 };
  periods.forEach((p, i) => {
    const b = cyclePeriodBounds(p), rows = bonusAll[i] || [];
    const bEarned = r2(rows.reduce((s, x) => s + num(x.amount), 0)), bGot = r2(rc['bonus|' + p] || 0);
    const dm = dmgBy[p] || { cost: 0, units: 0, items: {} };
    const dEarned = r2(dm.cost), dGot = r2(rc['damage|' + p] || 0);
    const bPend = r2(Math.max(0, bEarned - bGot)), dPend = r2(Math.max(0, dEarned - dGot));
    const running = p === cur;
    tot.bonusPending += bPend; tot.damagePending += dPend;
    tot[running ? 'bonusRunning' : 'bonusPast'] += bPend; tot[running ? 'damageRunning' : 'damagePast'] += dPend;
    if (!running && bEarned <= 0 && dEarned <= 0 && bGot <= 0 && dGot <= 0) return;
    months.push({
      period: p, from: b.start, to: b.end, running,
      bonus: { earned: bEarned, received: bGot, pending: bPend,
        items: rows.filter(x => num(x.amount) > 0).map(x => ({ name: x.name, sold: x.totalGiven, caseSize: x.caseSize, freeUnits: x.bonusUnits, freeMoney: x.bonusMoney, amount: num(x.amount) })) },
      damage: { earned: dEarned, received: dGot, pending: dPend, units: dm.units,
        items: Object.keys(dm.items).map(n => ({ name: n, amount: r2(dm.items[n]) })).sort((a, c) => c.amount - a.amount) }
    });
  });
  Object.keys(tot).forEach(k => { tot[k] = r2(tot[k]); });
  const recent = receipts.slice().sort((a, c) => String(c.created_at).localeCompare(String(a.created_at))).slice(0, 40).map(mapReceipt);
  return res.json({ ok: true, ready, current: cur, months, totals: Object.assign(tot, { pending: r2(tot.bonusPending + tot.damagePending) }), receipts: recent, capped: periods.length >= PERIOD_MAX });
}

async function handleReceive(req, res) {
  return idemRun(req, res, 'rcpt', async () => {
    const d = req.body || {};
    const kind = d.kind === 'damage' ? 'damage' : (d.kind === 'bonus' ? 'bonus' : '');
    if (!kind) return res.json({ ok: false, error: 'বোনাস নাকি ড্যামেজ — বেছে নিন' });
    if (!PERIOD_RE.test(String(d.period || ''))) return res.json({ ok: false, error: 'মাস বেছে নিন' });
    const amount = r2(num(d.amount));
    if (!(amount > 0)) return res.json({ ok: false, error: 'কত টাকা পেয়েছেন লিখুন' });
    if (amount > 1e9) return res.json({ ok: false, error: 'টাকার অঙ্ক ঠিক নেই' });
    const date = DATE_RE.test(d.date || '') ? d.date : today();
    if (date > today()) return res.json({ ok: false, error: 'ভবিষ্যতের তারিখ দেওয়া যাবে না' });
    const b = cyclePeriodBounds(d.period);
    const { data, error } = await supabase.from('company_receipts').insert({ kind, period: d.period, from_date: b.start, to_date: b.end, amount, received_date: date, note: str(d.note, 300) }).select().single();
    if (error) {
      if (_noTable(error)) return res.json({ ok: false, error: 'ডাটাবেসে v10 আপডেট (migrate-v10-offers-deposits.sql) এখনও চালানো হয়নি' });
      throw error;
    }
    await auditLog({ id: 'owner', role: 'owner' }, 'create', 'company_receipts', data.id, null, data);
    res.json({ ok: true, receipt: mapReceipt(data) });
  });
}

async function handleUndoReceipt(req, res) {
  if (!(await needPin(req, res, req.query.pin))) return;
  const id = String(req.query.id || '');
  const { data: old } = await supabase.from('company_receipts').select('*').eq('id', id).maybeSingle();
  if (!old) return res.json({ ok: false, error: 'রেকর্ড পাওয়া যায়নি' });
  const { error } = await supabase.from('company_receipts').delete().eq('id', id);
  if (error) throw error;
  await auditLog({ id: 'owner', role: 'owner' }, 'delete', 'company_receipts', id, old, null);
  return res.json({ ok: true });
}
