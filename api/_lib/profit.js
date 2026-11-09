// api/_lib/profit.js — AXIION DMS v14 (Step 3): PROFIT = cash profit + offer profit.   Helper, NOT a serverless function.
//
// Every figure comes from STORED snapshots (price after the offer deduction, buyPrice, offerDeductionTotal) — never today's price.
//   cash profit  = (shop price after offer − snapshot buyPrice) × qty, after commission / discount (the existing computeProfit finalProfit)
//   offer profit = offerDeductionTotal of the sale lines − return reversals, booked on the SALE date   (getOfferAllocation days[].earned)
//   total        = cash + offer  (+ সমন্বয় on the PAYMENT date, the difference only)
// A company payment is cash/bank received, never profit: it only moves the offer from "বাকি" to "প্রাপ্ত" (the total does not change).
// Everything is a sum over dates, so a range total always equals the sum of its daily totals.
const { computeProfit, num, today } = require('./db');
const { getOfferStart } = require('./offer');
const { loadNorm, loadPayments } = require('./offerHandler');
const { getOfferAllocation } = require('./offerLedger');

const r2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const dstr = (d) => String(d || '').slice(0, 10);
function dayBefore(d) { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); }

const PRIV = { owner: 1, manager: 1 };
function isPriv(req) { return !!PRIV[String((req && req.user) || '').toLowerCase()]; }

// keys a DSR / SO (or any non owner / manager) must never receive — removed from EVERY API response (withBiz wraps res.json)
const SECRET_KEY = /profit|buyprice|purchaseprice|casepurchase|^offer|^bonus(free|cases|$)|receivable|ledger|^cost$|^totalcost$|^receipts$|^settledby$|^adjustments?$|^companypay/i;
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach(k => { if (!SECRET_KEY.test(k)) o[k] = scrub(v[k]); }); return o; }
  return v;
}

// offer figures for [from,to] from getOfferAllocation (pure) — payments are loaded from the company payment log
async function offerRange(from, to) {
  const [{ norm }, payments] = await Promise.all([loadNorm(), loadPayments()]);
  const A = getOfferAllocation(norm.sales, norm.returns, payments);
  const inR = (d) => d >= from && d <= to;
  const days = {};
  const slot = (d) => (days[d] = days[d] || { date: d, earned: 0, received: 0, pending: 0, adjustment: 0 });
  A.days.filter(x => inR(x.date)).forEach(x => { const o = slot(x.date); o.earned = x.earned; o.received = x.received; o.pending = x.pending; });
  A.adjustments.filter(x => inR(x.date)).forEach(x => { slot(x.date).adjustment = r2(slot(x.date).adjustment + x.amount); });
  const byId = {}; payments.forEach(p => { byId[p.id] = p; });
  // which payment settled the offers of this range
  const sb = {};
  (A.settlements || []).filter(s => inR(s.date)).forEach(s => { const o = sb[s.paymentId] || (sb[s.paymentId] = { paymentId: s.paymentId, date: s.paymentDate, note: (byId[s.paymentId] || {}).note || '', amount: 0 }); o.amount = r2(o.amount + s.amount); });
  const list = Object.values(days).sort((a, b) => a.date.localeCompare(b.date));
  const sum = (k) => r2(list.reduce((s, d) => s + d[k], 0));
  return {
    earned: sum('earned'), received: sum('received'), pending: sum('pending'), adjustment: sum('adjustment'),
    days, settledBy: Object.values(sb).sort((a, b) => a.date.localeCompare(b.date)),
    payments: A.payments.filter(p => inR(p.date)).map(p => Object.assign({ note: (byId[p.id] || {}).note || '' }, p)),   // company payments received in the range (cash/bank, NOT profit)
    owed: A.total.pending, owedEarned: A.total.earned, paidTotal: A.total.paid, adjustmentAll: A.total.adjustment   // all-time: what the company still owes (পাওনা অফার)
  };
}

// computeProfit + the offer → the figures of the panel / dashboard / report
async function computeProfitFull(from, to) {
  const start = await getOfferStart();
  const [p, of] = await Promise.all([computeProfit(from, to, { bonusTo: start ? dayBefore(start) : to }), offerRange(from, to)]);
  const cash = p.finalProfit;
  const total = r2(cash + of.earned + of.adjustment);
  return Object.assign({}, p, {
    offerStart: start || '', cashProfit: r2(cash), offerProfit: of.earned, offerReceived: of.received, offerPending: of.pending, offerAdjustment: of.adjustment,
    totalProfit: total, offerSettledBy: of.settledBy, offerOwed: of.owed,
    normalSales: r2(p.revenue + of.earned), offerDeduction: of.earned, actualSales: p.revenue, purchaseCost: p.cost,
    _offer: of
  });
}

module.exports = { computeProfitFull, offerRange, isPriv, scrub, dayBefore, SECRET_KEY };
