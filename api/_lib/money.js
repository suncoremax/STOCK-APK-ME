// api/_lib/money.js — AXIION DMS (manual edition)
// ONE place that turns "what the screen sent" into "what gets stored".
//
//  CALC-5  prices / costs are read from the products table on the server;
//          numbers sent by the browser are ignored (except the buy-price of a
//          purchase, which is genuinely typed in by the owner).
//  CALC-6  money is rounded per bill line to 2 decimals, and whole cases are
//          priced from the case price (406 / 24 = 16.9167 no longer leaves
//          406.0008 behind).
//  CALC-3  every sale row also remembers the bonus rule that was valid on
//          that day, so editing a product later cannot rewrite old bonus.
//
// This file lives in api/_lib/ so it does NOT count as a serverless function
// on the Vercel Hobby plan (underscore folders are excluded).
const { supabase, num, fetchAll } = require('./db');
const { calcOfferDeduction, grossOf, lineDeduction, wholeCases, getOfferStart, offerOnFor } = require('./offer');   // v12 auto offer deduction

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const r2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const r4 = (n) => Math.round((num(n) + Number.EPSILON) * 10000) / 10000;

const PRODUCT_COLS = 'id,name,sku,case_size,case_price,case_purchase_price,purchase_price,selling_price,' +
  'bonus_free_units,bonus_cases_req,bonus_free_money,current_stock';

// { [productId]: productRow } for the ids that are real UUIDs.
async function loadProducts(ids) {
  const list = [...new Set((ids || []).map(String).filter(x => UUID_RE.test(x)))];
  const map = {};
  for (let i = 0; i < list.length; i += 100) {
    const { data, error } = await supabase.from('products').select(PRODUCT_COLS).in('id', list.slice(i, i + 100));
    if (error) throw error;
    (data || []).forEach(p => { map[String(p.id)] = p; });
  }
  return map;
}

// Money for `units` pieces of a product.
//   * whole cases are charged at the case price
//   * the loose remainder at the per-piece price
//   * `unitPriceOverride` (used for returns at the price the DSR was charged)
//     simply multiplies.
// Always rounded to 2 decimals per line.
function lineMoney(prod, units, kind /* 'sell' | 'buy' */, unitPriceOverride) {
  units = num(units);
  const cs = num(prod && prod.case_size) || 1;
  const unit = kind === 'buy' ? num(prod && prod.purchase_price) : num(prod && prod.selling_price);
  if (unitPriceOverride !== undefined && unitPriceOverride !== null) return r2(units * num(unitPriceOverride));
  const casePrice = (kind === 'buy' ? num(prod && prod.case_purchase_price) : num(prod && prod.case_price)) || unit * cs;
  const whole = Math.floor(units / cs + 1e-9);
  const rem = units - whole * cs;
  return r2(whole * casePrice + rem * unit);
}

// Pieces for an item. cases/pcs win when present (the screen always sends
// both), otherwise totalUnits is used.
function itemUnits(item, prod, csOverride) {
  const cs = num(csOverride) || num(prod && prod.case_size) || 1;
  const cases = num(item.cases), pcs = num(item.pcs);
  if (cases !== 0 || pcs !== 0) return r4(cases * cs + pcs);
  return r4(num(item.totalUnits));
}

// Price the DSR was actually charged for the stock he is handing back:
// the weighted average of his most recent loading day for each product
// (falls back to the current catalogue price).
async function weightedGivePrices(srId, productIds, uptoDate) {
  const out = {};
  const ids = [...new Set((productIds || []).map(String).filter(Boolean))];
  if (!srId || !ids.length) return out;
  const rows = await fetchAll(() => {
    let q = supabase.from('transactions').select('product_id,date,total_units,total_revenue')
      .eq('sr_id', String(srId)).eq('type', 'give').in('product_id', ids);
    if (uptoDate) q = q.lte('date', uptoDate);
    return q.order('date', { ascending: false });
  });
  const latest = {};
  (rows || []).forEach(r => {
    const k = String(r.product_id), d = String(r.date).slice(0, 10);
    if (!latest[k] || d > latest[k]) latest[k] = d;
  });
  const acc = {};
  (rows || []).forEach(r => {
    const k = String(r.product_id), d = String(r.date).slice(0, 10);
    if (d !== latest[k]) return;
    const a = acc[k] || (acc[k] = { u: 0, v: 0 });
    a.u += num(r.total_units); a.v += num(r.total_revenue);
  });
  Object.keys(acc).forEach(k => { if (acc[k].u > 0) out[k] = acc[k].v / acc[k].u; });
  return out;
}

// ── v11 PRICE-CHANGE SAFETY ───────────────────────────────────────────────────────────────────
// A return must be valued with the SNAPSHOT of the sale it undoes (sell price, buy price, pieces per case, offer rule),
// never with today's product row.  DSR/SO return  -> that DSR's latest 'give' day.   Shop return -> that shop's latest 'point_sale' day.
// Returns { [productId]: { sp, pp, cs, bcr, free, money, legacy } } (per-piece prices, weighted over that day).
async function sourceSnapshots(opts, ids) {
  const out = {}, type = opts.type || '';
  ids = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!ids.length) return out;
  let srcType = '', col = '', val = '', backTypes = [];
  if ((type === 'return' || type === 'damage') && opts.srId) { srcType = 'give'; col = 'sr_id'; val = String(opts.srId); backTypes = ['return', 'damage']; }
  else if (type === 'point_damage_return' && opts.shopId) { srcType = 'point_sale'; col = 'shop_id'; val = String(opts.shopId); backTypes = ['point_damage_return']; }
  else return out;
  const rows = await fetchAll(() => {
    let q = supabase.from('transactions')
      .select('product_id,date,created_at,total_units,total_revenue,total_cost,selling_price,rule_case_size,rule_bonus_cases_req,rule_bonus_free_units,rule_bonus_free_money')
      .eq(col, val).eq('type', srcType).in('product_id', ids);
    if (opts.date) q = q.lte('date', opts.date);
    return q.order('date', { ascending: false });
  });
  const latest = {};
  (rows || []).forEach(r => { const k = String(r.product_id), d = String(r.date).slice(0, 10); if (!latest[k] || d > latest[k]) latest[k] = d; });
  const acc = {};
  (rows || []).forEach(r => {
    const k = String(r.product_id); if (String(r.date).slice(0, 10) !== latest[k]) return;
    const a = acc[k] || (acc[k] = { u: 0, v: 0, c: 0, d: 0, rule: null, at: '', day: latest[k] });
    const ded = lineDeduction(r);                                     // v12: the offer taken off this sale line (0 for old lines)
    a.u += num(r.total_units); a.v += num(r.total_revenue) + ded; a.c += num(r.total_cost); a.d += ded;   // v = GROSS money (before the offer)
    if (r.rule_case_size !== null && r.rule_case_size !== undefined && String(r.created_at || '') >= a.at) { a.rule = r; a.at = String(r.created_at || ''); }
  });
  // v12: pieces already handed back against that sale (same DSR / shop, on or after the sale day) — so the offer is reversed exactly once
  const prior = {};
  const keys = Object.keys(acc);
  if (keys.length) {
    const back = await fetchAll(() => {
      let q = supabase.from('transactions').select('product_id,date,total_units').eq(col, val).in('type', backTypes).in('product_id', keys);
      if (opts.date) q = q.lte('date', opts.date);
      return q;
    });
    (back || []).forEach(r => { const k = String(r.product_id); if (acc[k] && String(r.date).slice(0, 10) >= acc[k].day) prior[k] = (prior[k] || 0) + num(r.total_units); });
  }
  const extra = opts.priorExtra || {};
  Object.keys(acc).forEach(k => {
    const a = acc[k]; if (!(a.u > 0)) return;
    const o = { sp: a.v / a.u, pp: a.c / a.u, legacy: !a.rule, srcUnits: a.u, srcDed: r2(a.d), prior: (prior[k] || 0) + num(extra[k]) };
    if (a.rule) { o.cs = num(a.rule.rule_case_size) || 1; o.bcr = num(a.rule.rule_bonus_cases_req); o.free = num(a.rule.rule_bonus_free_units); o.money = num(a.rule.rule_bonus_free_money); }
    out[k] = o;
  });
  return out;
}

// v12 — offer to take back when `units` pieces come back from a sale that carried a deduction.
// remaining qualifying deduction BEFORE the return minus remaining AFTER it (cumulative method: nothing drifts however many returns).
function offerReversal(sn, units) {
  if (!sn || !(sn.srcDed > 0)) return { reversal: 0, perCase: 0 };
  const cs = sn.cs || 1, X = sn.bcr > 0 ? sn.bcr : 1;
  const calc = calcOfferDeduction({ sellPrice: r4(sn.sp), unitsPerCase: cs, offerCasesReq: X, offerFreeUnits: sn.free, offerFreeMoney: sn.money }, 0);
  const q = (k) => r2(calc.perCaseExact * (Math.floor(k / X + 1e-9) * X));
  const before = Math.max(0, num(sn.srcUnits) - num(sn.prior)), after = Math.max(0, before - num(units));
  const rev = Math.min(sn.srcDed, Math.max(0, r2(q(wholeCases(before, cs)) - q(wholeCases(after, cs)))));
  return { reversal: rev, perCase: calc.perCase };
}

// The snapshot of a stored transaction row, in the field names the app uses everywhere.
//   hasSnapshot : the row carries its own rule columns          legacy : old line (no snapshot yet, or frozen without offer)
// The offer-deduction figures are DERIVED from the stored snapshot, so they can never drift when the product changes.
function snapOf(row) {
  const has = (v) => v !== null && v !== undefined;
  const hasSnapshot = has(row.rule_case_size);
  const cs = hasSnapshot ? (num(row.rule_case_size) || 1) : 0;
  const bcr = hasSnapshot ? num(row.rule_bonus_cases_req) : 0;
  const free = hasSnapshot ? num(row.rule_bonus_free_units) : 0, money = hasSnapshot ? num(row.rule_bonus_free_money) : 0;
  const pp = num(row.purchase_price);
  // v12: the deduction of a stored line = gross from its own snapshot − the revenue that was saved (never recalculated from today's product)
  const ded = hasSnapshot ? lineDeduction(row) : 0;
  const calc = ded > 0 ? calcOfferDeduction({ sellPrice: num(row.selling_price), unitsPerCase: cs, offerCasesReq: bcr || 1, offerFreeUnits: free, offerFreeMoney: money }, 0) : null;
  return {
    sellPrice: num(row.selling_price), buyPrice: pp, unitsPerCase: cs, offerCasesReq: bcr, offerFreeUnits: free, offerFreeMoney: money,
    offerDeductionPerCase: calc ? calc.perCase : 0, offerDeductionTotal: ded, offerApplied: ded > 0,
    shopPricePerCase: calc ? calc.shopPerCase : 0, grossAmount: hasSnapshot ? grossOf(row.total_units, row.selling_price, cs) : num(row.total_revenue),
    snapshotAt: row.snapshot_at || row.created_at || '', hasSnapshot, legacy: !hasSnapshot || bcr === 0,
    frozenAt: row.frozen_at || ''
  };
}

// Turn the items array of a request into trusted lines.
//   opts.type            transaction type (decides which prices are used)
//   opts.srId / opts.date  needed for 'return' / 'damage' (price-at-give lookup: the DSR is credited at the price he was charged)
// Returns { ok:true, lines, products } or { ok:false, error }.
const SALE_TYPES = { give: 1, point_sale: 1 };
async function priceItems(items, opts) {
  opts = opts || {};
  const type = opts.type || '';
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'কমপক্ষে একটি আইটেম দিন' };
  const prods = await loadProducts(items.map(i => i && i.productId));
  const offerStart = SALE_TYPES[type] ? await getOfferStart() : '';   // v12
  const src = await sourceSnapshots(opts, Object.keys(prods));   // v11: the original sale's snapshot (prices, pieces per case, offer)
  const lines = [];
  for (const item of items) {
    const pid = String((item && item.productId) || '');
    const prod = prods[pid];
    if (!prod) return { ok: false, error: 'পণ্য পাওয়া যায়নি' };
    const name = prod.name || 'পণ্য';
    const rawU = num(item.totalUnits), rawC = num(item.cases), rawP = num(item.pcs);
    if (rawU < 0 || rawC < 0 || rawP < 0) return { ok: false, error: name + ' — ঋণাত্মক পরিমাণ দেওয়া যাবে না' };
    const sn = src[pid];
    const units = itemUnits(item, prod, sn && sn.cs);
    if (units <= 0) return { ok: false, error: name + ' — পরিমাণ ০-এর বেশি হতে হবে' };

    let revenue, cost, sp, pp, gross, offerDed = 0, offerPerCase = 0, offerCases = 0;
    const cs0 = (sn && sn.cs) || num(prod.case_size) || 1;
    if (sn) {
      sp = sn.sp; revenue = lineMoney(prod, units, 'sell', sn.sp); gross = revenue;
      if (sn.srcDed > 0) {   // v12: the sale carried an offer deduction → hand back the matching part (proportional, from the ORIGINAL snapshot)
        const rv = offerReversal(sn, units);
        gross = grossOf(units, r4(sn.sp), cs0); offerDed = rv.reversal; offerPerCase = rv.perCase; revenue = r2(gross - offerDed);
      }
    } else { sp = num(prod.selling_price); revenue = lineMoney(prod, units, 'sell'); gross = revenue; }

    if (sn) {
      pp = sn.pp; cost = r2(units * sn.pp);   // a return is valued at the buy price of the sale it undoes
    } else if (type === 'buy' && num(item.purchasePrice) > 0) {
      // the owner types the real invoice price of a purchase
      pp = num(item.purchasePrice); cost = r2(units * pp);
    } else {
      pp = num(prod.purchase_price); cost = lineMoney(prod, units, 'buy');
    }
    const cs = (sn && sn.cs) || num(prod.case_size) || 1;
    const snap = sn
      ? { sellPrice: r4(sp), buyPrice: r4(pp), unitsPerCase: cs, offerCasesReq: sn.legacy ? 0 : sn.bcr, offerFreeUnits: sn.legacy ? 0 : sn.free, offerFreeMoney: sn.legacy ? 0 : sn.money }
      : { sellPrice: r4(sp), buyPrice: r4(pp), unitsPerCase: cs, offerCasesReq: num(prod.bonus_cases_req) || 1, offerFreeUnits: num(prod.bonus_free_units), offerFreeMoney: num(prod.bonus_free_money) };
    snap.snapshotAt = new Date().toISOString();
    if (!sn && SALE_TYPES[type] && snap.offerCasesReq > 0 && offerOnFor(offerStart, opts.date)) {   // v12: auto offer deduction on a sale (whole qualifying cases only)
      const calc = calcOfferDeduction({ casePrice: num(prod.case_price), sellPrice: r4(sp), unitsPerCase: cs, offerCasesReq: snap.offerCasesReq, offerFreeUnits: snap.offerFreeUnits, offerFreeMoney: snap.offerFreeMoney }, wholeCases(units, cs));
      if (calc.active && calc.total > 0) { offerDed = Math.min(calc.total, gross); offerPerCase = calc.perCase; offerCases = calc.qualifyingCases; revenue = r2(gross - offerDed); }
    }
    snap.offerDeductionPerCase = offerPerCase; snap.offerDeductionTotal = offerDed;
    lines.push({
      snap, prod, productId: pid, productName: prod.name || '', sku: prod.sku || '',
      units, cases: Math.floor(units / cs + 1e-9), pcs: r4(units - Math.floor(units / cs + 1e-9) * cs),
      sellingPrice: r4(sp), purchasePrice: r4(pp), revenue, cost, gross, offerDeduction: offerDed, offerPerCase, offerCases,
      commission: num(item.commission), discount: num(item.discount)
    });
  }
  return { ok: true, lines, products: prods };
}

// Columns every sale-type row carries so bonus uses the rule of THAT day.
function bonusSnapshot(prod) {
  return {
    rule_case_size: num(prod.case_size) || 1,
    rule_bonus_cases_req: num(prod.bonus_cases_req) || 1,
    rule_bonus_free_units: num(prod.bonus_free_units),
    rule_bonus_free_money: num(prod.bonus_free_money)
  };
}

// Base transaction row from a priced line.
function txRow(line, base) {
  return Object.assign({
    product_id: line.productId, product_name: line.productName, sku: line.sku,
    cases: line.cases, pcs: line.pcs, total_units: line.units,
    purchase_price: line.purchasePrice, selling_price: line.sellingPrice,
    total_cost: line.cost, total_revenue: line.revenue
  }, line.snap ? {
    rule_case_size: line.snap.unitsPerCase, rule_bonus_cases_req: line.snap.offerCasesReq,
    rule_bonus_free_units: line.snap.offerFreeUnits, rule_bonus_free_money: line.snap.offerFreeMoney
  } : bonusSnapshot(line.prod), base);
}

// Stock check for outgoing movements (give / point_sale / return_company).
// Returns an error string or ''. The database trigger is the real guard
// (race-proof); this gives a readable message before anything is written.
function stockShortage(lines) {
  const want = {};
  lines.forEach(l => { want[l.productId] = (want[l.productId] || 0) + l.units; });
  for (const l of lines) {
    const have = num(l.prod.current_stock);
    if (want[l.productId] > have + 0.0001) {
      return (l.prod.name || 'পণ্য') + ' — স্টকে আছে ' + have + ' পিস, কিন্তু ' + want[l.productId] + ' পিস লাগবে';
    }
  }
  return '';
}


// ── v10 — company OFFER passed on to the shop ─────────────────────────────────────────────────
// A product can carry a company offer: "for every N cases sold, F free pieces and ৳M free money".
// The distributor passes it on to the shops as a lower price: for every piece sold the shop gets back
//     (F × buying price + M) ÷ (N × pieces-per-case)
// That money is later received from the company, so it is shown as a receivable (see claims.js).
function offerPerUnit(free, money, casesReq, caseSize, buyPrice) {
  const d = (num(casesReq) || 1) * (num(caseSize) || 1);
  return d > 0 ? (num(free) * num(buyPrice) + num(money)) / d : 0;
}
// the offer rule that was valid on a transaction row (its own snapshot columns). v11: a row WITHOUT a snapshot is an old line:
// it gets no offer and is never recalculated from today's product (second argument kept only so old callers still work).
function rowOfferPerUnit(row, _prod) {   // v12: average deduction per piece of a stored line (its real, stored deduction)
  const u = num(row && row.total_units); return u > 0 ? lineDeduction(row) / u : 0;
}
// offer value of a priced line (used when goods are handed out)
function lineOffer(line) { return r2(num(line && line.offerDeduction)); }   // v12: the deduction really applied to this priced line

// v11 — new quantity for an EXISTING line (edit of an old sale): revenue / cost / pieces-per-case come from the line's own snapshot,
// never from today's product. Returns the fields to write back; the snapshot columns are left exactly as they were.
function repriceFromSnapshot(row, newUnits) {
  const units = r4(newUnits), sn = snapOf(row);
  const cs = sn.unitsPerCase || 1, whole = Math.floor(units / cs + 1e-9);
  const old = lineDeduction(row), oldU = num(row.total_units);
  let revenue = r2(units * num(row.selling_price));
  if (old > 0) {   // v12: keep the offer of the line (same snapshot): sale lines recompute it, return lines scale it proportionally
    const isSale = row.type === 'give' || row.type === 'point_sale';
    const ded = isSale ? calcOfferDeduction({ sellPrice: num(row.selling_price), unitsPerCase: cs, offerCasesReq: sn.offerCasesReq || 1, offerFreeUnits: sn.offerFreeUnits, offerFreeMoney: sn.offerFreeMoney }, whole).total
      : (oldU > 0 ? r2(old * units / oldU) : 0);
    revenue = r2(grossOf(units, row.selling_price, cs) - ded);
  }
  return { total_units: units, cases: whole, pcs: r4(units - whole * cs), total_revenue: revenue, total_cost: r2(units * num(row.purchase_price)) };
}
module.exports = { offerReversal, repriceFromSnapshot, snapOf, sourceSnapshots, r2, r4, offerPerUnit, rowOfferPerUnit, lineOffer, UUID_RE, loadProducts, lineMoney, itemUnits, weightedGivePrices, priceItems, bonusSnapshot, txRow, stockShortage };

// ── Undo helpers (delete of a wrongly typed entry) ─────────────────────
// The stock trigger only fires on INSERT, so deleting rows must give the stock back by hand.
const STOCK_SIGN = { buy: 1, give: -1, return: 1, point_sale: -1, point_damage_return: 1, return_company: -1 };
// Reverse the stock effect of `rows` (transactions rows). Returns an error string or ''.
async function reverseStock(rows, guardNegative) {
  const delta = {};
  (rows || []).forEach(r => { const s = STOCK_SIGN[r.type]; if (s) delta[String(r.product_id)] = (delta[String(r.product_id)] || 0) - s * num(r.total_units); });
  const ids = Object.keys(delta).filter(k => Math.abs(delta[k]) > 0);
  if (!ids.length) return '';
  const prods = await loadProducts(ids);
  if (guardNegative) for (const id of ids) {
    const p = prods[id]; if (!p) continue;
    if (num(p.current_stock) + delta[id] < -0.0001) return (p.name || 'পণ্য') + ' — মুছলে স্টক ঋণাত্মক হয়ে যাবে (স্টকে আছে ' + num(p.current_stock) + ' পিস)';
  }
  for (const id of ids) {
    const p = prods[id]; if (!p) continue;
    const { error } = await supabase.from('products').update({ current_stock: r4(num(p.current_stock) + delta[id]) }).eq('id', id);
    if (error) throw error;
  }
  return '';
}
module.exports.reverseStock = reverseStock;
module.exports.STOCK_SIGN = STOCK_SIGN;
