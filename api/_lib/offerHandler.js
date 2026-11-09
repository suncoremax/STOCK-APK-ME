// api/_lib/offerHandler.js — AXIION DMS v13 (Step 2): COMPANY OFFER LEDGER ("কোম্পানি অফার হিসাব").  Helper, NOT a serverless function:
// it is called from api/claims.js as  claims?type=offer&action=…   (the 12-function limit stays untouched).
//   GET  ?type=offer&action=ledger                      ledger per product + totals + payments + adjustments
//   GET  ?type=offer&action=report&from=&to=&mode=      "কোম্পানিকে বিক্রয় পাঠান": cases + bottles per product (range or since the last payment)
//   POST ?type=offer  {action:'pay-add'|'pay-edit'|'pay-del', …}      company payments (edit / delete ask the owner PIN)
// ACCESS: owner and manager only.  A token of any other user (DSR / SO …) is rejected here, whatever the screen shows.
// STORAGE (no migration): company payments are kept as an append-only event list in the existing `audit_log` table
//   (table_name 'offer_payment', one row per add / edit / delete); the current list is replayed from it.  Nothing old is ever rewritten.
const crypto = require('crypto');
const { supabase, num, str, today, fetchAll, safeErr, idemRun } = require('./db');
const { needPin } = require('./auth');
const { lineDeduction, getOfferStart } = require('./offer');
const { normRows, buildLedger, buildReport } = require('./offerLedger');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED = { owner: 1, manager: 1 };
const TABLE = 'offer_payment';
const r2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

function allowed(req) { const u = String((req && req.user) || '').toLowerCase(); return !!ALLOWED[u]; }

// ── payments: replay the audit_log events ──
async function loadPayments() {
  const rows = await fetchAll(() => supabase.from('audit_log').select('id,at,row_id,action,new_data').eq('table_name', TABLE));
  rows.sort((a, b) => (num(a.new_data && a.new_data.ts) || Date.parse(a.at) || 0) - (num(b.new_data && b.new_data.ts) || Date.parse(b.at) || 0));
  const map = new Map();
  rows.forEach(r => {
    const d = r.new_data || {};
    if (r.action === 'offer_pay_del') { map.delete(String(r.row_id)); return; }
    if (r.action === 'offer_pay_add') map.set(String(r.row_id), Object.assign({}, d.payment, { id: String(r.row_id), createdAt: r.at }));
    else if (r.action === 'offer_pay_edit' && map.has(String(r.row_id))) map.set(String(r.row_id), Object.assign({}, map.get(String(r.row_id)), d.payment, { id: String(r.row_id), editedAt: r.at }));
  });
  return [...map.values()].map(p => ({ id: p.id, date: p.date, amount: r2(p.amount), note: p.note || '', productIds: Array.isArray(p.productIds) ? p.productIds : [], from: p.from || '', to: p.to || '', close: !!p.close, createdAt: p.createdAt || '', editedAt: p.editedAt || '' }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.createdAt) < String(b.createdAt) ? -1 : 1));
}
async function writeEvent(action, id, payload) {
  const { error } = await supabase.from('audit_log').insert({ actor_id: 'owner', actor_role: 'owner', action, table_name: TABLE, row_id: id, old_data: null, new_data: Object.assign({ ts: Date.now() }, payload) });
  if (error) throw error;
}
function cleanPayment(d) {
  const amount = r2(num(d.amount));
  if (!(amount > 0)) return { error: 'কত টাকা পেয়েছেন লিখুন' };
  if (amount > 1e9) return { error: 'টাকার অঙ্ক ঠিক নেই' };
  const date = DATE_RE.test(d.date || '') ? d.date : today();
  if (date > today()) return { error: 'ভবিষ্যতের তারিখ দেওয়া যাবে না' };
  const productIds = (Array.isArray(d.productIds) ? d.productIds : []).map(String).filter(x => UUID_RE.test(x)).slice(0, 200);
  const from = DATE_RE.test(d.from || '') ? d.from : '', to = DATE_RE.test(d.to || '') ? d.to : '';
  if (from && to && from > to) return { error: 'সময়ের শুরু তারিখ শেষের আগে হতে হবে' };
  return { payment: { date, amount, note: str(d.note, 300), productIds, from, to, close: d.close === true || d.close === 'true' } };
}

// ── ledger data ──
async function loadNorm() {
  const start = await getOfferStart();
  const rows = await fetchAll(() => {
    let q = supabase.from('transactions').select('type,date,product_id,product_name,cases,pcs,total_units,total_revenue,selling_price,rule_case_size,rule_bonus_free_units,rule_bonus_free_money,created_at')
      .in('type', ['give', 'point_sale', 'return', 'damage', 'point_damage_return']);
    if (start) q = q.gte('date', start);
    return q;
  });
  return { start, norm: normRows(rows, lineDeduction, { start }) };
}
async function ledger() {
  const [{ start, norm }, payments] = await Promise.all([loadNorm(), loadPayments()]);
  const L = buildLedger(norm, payments);
  const byId = {}; L.payments.forEach(p => { byId[p.id] = p; });
  return { ok: true, offerStartDate: start || '', products: L.products, total: L.total, days: L.days, adjustments: L.adjustments,
    payments: payments.map(p => Object.assign({}, p, { applied: (byId[p.id] || {}).applied || 0, excess: (byId[p.id] || {}).excess || 0, writtenOff: (byId[p.id] || {}).writtenOff || 0, adjustment: (byId[p.id] || {}).adjustment || 0, kind: (byId[p.id] || {}).kind || '' })).reverse() };
}

async function handleOffer(req, res) {
  if (!allowed(req)) return res.status(403).json({ ok: false, forbidden: true, error: 'এই অংশ শুধু মালিক ও ম্যানেজারের জন্য' });
  const q = req.query || {}, d = req.body || {};
  const action = String(req.method === 'GET' ? (q.action || 'ledger') : (d.action || q.action || ''));
  try {
    if (req.method === 'GET') {
      if (action === 'ledger') return res.json(await ledger());
      if (action === 'report') {
        const [{ norm }, payments] = await Promise.all([loadNorm(), loadPayments()]);
        const to = DATE_RE.test(q.to || '') ? q.to : today();
        let from = DATE_RE.test(q.from || '') ? q.from : to;
        const mode = q.mode === 'since' ? 'since' : 'range';
        const lo = from <= to ? from : to, hi = from <= to ? to : from;
        const rep = buildReport(norm, payments, { from: lo, to: hi, mode });
        return res.json(Object.assign({ ok: true }, rep));
      }
      return res.json({ ok: false, error: 'Unknown action' });
    }
    if (req.method === 'POST') return idemRun(req, res, 'offer', async () => {
      if (action === 'pay-add') {
        const c = cleanPayment(d); if (c.error) return res.json({ ok: false, error: c.error });
        const id = crypto.randomUUID();
        await writeEvent('offer_pay_add', id, { payment: c.payment });
        return res.json(Object.assign(await ledger(), { savedId: id }));
      }
      if (action === 'pay-edit' || action === 'pay-del') {
        if (!(await needPin(req, res, d.pin))) return;
        const id = String(d.id || ''); if (!UUID_RE.test(id)) return res.json({ ok: false, error: 'রেকর্ড পাওয়া যায়নি' });
        const cur = (await loadPayments()).find(p => p.id === id);
        if (!cur) return res.json({ ok: false, error: 'রেকর্ড পাওয়া যায়নি' });
        if (action === 'pay-del') { await writeEvent('offer_pay_del', id, { payment: cur }); return res.json(await ledger()); }
        const c = cleanPayment(Object.assign({}, cur, d)); if (c.error) return res.json({ ok: false, error: c.error });
        await writeEvent('offer_pay_edit', id, { payment: c.payment, before: cur });
        return res.json(await ledger());
      }
      return res.json({ ok: false, error: 'Unknown action' });
    });
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) { return res.json({ ok: false, error: safeErr(e) }); }
}

module.exports = { handleOffer, loadPayments, loadNorm, allowed };
