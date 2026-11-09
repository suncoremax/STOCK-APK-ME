// api/_lib/offer.js — AXIION DMS v12 (Step 1): AUTO OFFER DEDUCTION.  (helper, NOT a serverless function)
//
// A product offer: "for every X cases, F free bottles + M free money".  The shop still gets the real bottles;
// the shop price is lowered instead (the company pays the distributor later).
//   P = price per case,  U = bottles per case,  f = F / X,  m = M / X
//   value per bottle = P / (U + f)      case price = value × U      shop price per case = case price − m
//   deduction per case = P − shop price per case
// Only WHOLE cases that complete a group of X cases qualify (loose bottles get nothing).  The total is rounded ONCE from the
// exact per-case figure (cumulative / remainder method), so 10 cases never drift from 10 × a rounded per-case figure.
//
// STORAGE (no migration): a line stores its sale price, pieces-per-case and offer rule snapshot (rule_* columns) and its
// total_revenue = gross − deduction.  The deduction of a stored line is therefore ALWAYS "gross from the snapshot − stored revenue"
// (see lineDeduction) — it can never change when the product, its price or its offer change later; old lines (revenue = gross) give 0.
const { supabase, num, rawSupabase, bizCtx } = require('./db');

const r2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const r4 = (n) => Math.round((num(n) + Number.EPSILON) * 10000) / 10000;
const EPS = 1e-9;

// snapshot: { sellPrice (per piece) | casePrice, unitsPerCase, offerCasesReq, offerFreeUnits, offerFreeMoney }
function casePriceOf(s) {
  const cs = num(s.unitsPerCase) || 1;
  return num(s.casePrice) > 0 ? num(s.casePrice) : r2(num(s.sellPrice) * cs);   // per-piece price is case price ÷ pieces, so ×pieces gives the case price back
}
// calcOfferDeduction(snapshot, casesSold) -> { perCaseExact, perCase, qualifyingCases, total, valuePerBottle, casePrice, shopPerCase, active }
function calcOfferDeduction(snapshot, casesSold) {
  const s = snapshot || {};
  const U = num(s.unitsPerCase) || 1, X = num(s.offerCasesReq) > 0 ? num(s.offerCasesReq) : 1;
  const F = Math.max(0, num(s.offerFreeUnits)), M = Math.max(0, num(s.offerFreeMoney));
  const P = casePriceOf(s);
  const out = { perCaseExact: 0, perCase: 0, qualifyingCases: 0, total: 0, valuePerBottle: 0, casePrice: P, shopPerCase: P, active: false };
  if (!(P > 0) || (F <= 0 && M <= 0)) return out;
  const f = F / X, m = M / X;
  const value = P / (U + f), caseP = value * U, shop = caseP - m;
  const exact = Math.max(0, Math.min(P, P - shop));
  const whole = Math.max(0, Math.floor(num(casesSold) + EPS));
  const qual = Math.floor(whole / X + EPS) * X;               // only complete groups of X cases
  out.active = exact > 0; out.perCaseExact = exact; out.perCase = r2(exact);
  out.valuePerBottle = r4(value); out.shopPerCase = r2(P - exact);
  out.qualifyingCases = qual; out.total = r2(exact * qual);
  return out;
}
// whole cases in `units` pieces
const wholeCases = (units, cs) => Math.floor(num(units) / (num(cs) || 1) + EPS);

// the money for the pieces of a row BEFORE the offer: whole cases at the case price, the loose rest at the piece price
function grossOf(units, sellPrice, cs, casePrice) {
  cs = num(cs) || 1; units = num(units);
  const cp = num(casePrice) > 0 ? num(casePrice) : r2(num(sellPrice) * cs), w = wholeCases(units, cs);
  return r2(w * cp + (units - w * cs) * num(sellPrice));
}
// Deduction of a STORED row (sale rows: given / point_sale; reversal on return rows) = gross from its own snapshot − stored revenue.
// Anything below one paisa-rounding step is noise (old rows have revenue == gross).
function lineDeduction(row) {
  if (!row || row.rule_case_size === null || row.rule_case_size === undefined) return 0;
  const u = num(row.total_units), g = grossOf(u, row.selling_price, row.rule_case_size), d = r2(g - num(row.total_revenue));
  return d > 0.006 + 0.00006 * u ? d : 0;   // below this it is only the 4-decimal rounding of the per-piece price
}

// ── start date ("অফার হিসাব শুরুর তারিখ") — kept in biz_counters (key 'offer_start', value = YYYYMMDD): works with no migration ──
async function getOfferStart() {
  try {
    const c = bizCtx(); if (!c || !c.id) return '';
    const { data } = await rawSupabase.from('biz_counters').select('next_no').eq('business_id', c.id).eq('key', 'offer_start').maybeSingle();
    const n = data ? Math.floor(num(data.next_no)) : 0; if (n < 20000101) return '';
    const s = String(n); return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  } catch (e) { return ''; }
}
async function setOfferStart(dateStr) {   // '' switches the offer calculation off again
  const c = bizCtx(); if (!c || !c.id) throw new Error('NO_BUSINESS');
  const n = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') ? Number(dateStr.replace(/-/g, '')) : 0;
  const { error } = await rawSupabase.from('biz_counters').upsert({ business_id: c.id, key: 'offer_start', next_no: n }, { onConflict: 'business_id,key' });
  if (error) throw error;
  return n ? dateStr : '';
}
const offerOnFor = (start, date) => !!start && String(date || '').slice(0, 10) >= start;

module.exports = { calcOfferDeduction, grossOf, lineDeduction, wholeCases, casePriceOf, getOfferStart, setOfferStart, offerOnFor };
