// api/_lib/offerLedger.js — AXIION DMS v13 (Step 2): COMPANY OFFER LEDGER.  PURE helper (no database, NOT a serverless function).
//
// The offer a shop did not pay (v12 "কোম্পানি অফার ছাড়") is money the COMPANY owes the distributor.  This file turns the stored
// sale / return lines into a ledger and settles the company's payments against it — for DISPLAY ONLY, computed every time, nothing
// old is ever rewritten.
//
// INPUT SHAPES (all figures come from STORED snapshots — never from today's product price / offer):
//   sales    [{ date, productId, productName, deduction }]            deduction = offerDeductionTotal of a give / point_sale line
//   returns  [{ date, productId, productName, reversal  }]            reversal  = the offer taken back by a return / damage line
//   payments [{ id, date, amount, note, productIds[], from, to, close }]
//            productIds: [] = not tied to a product (settles the oldest earned offers of ALL products);  from/to: optional sale-date window
//            close: owner chose "সমন্বয় সহ বন্ধ করুন" — an underpayment is closed and the shortfall becomes a NEGATIVE adjustment
//
// RULES
//  • FIFO by sale date: a payment settles the OLDEST pending earned offers first (only offers dated on / before the payment date).
//  • A payment is cash/bank received, NOT profit.  It touches profit only through an ADJUSTMENT dated on the payment date:
//        paid more than was pending      → +(paid − pending)            kind 'over'
//        paid less AND close chosen      → −(pending − paid)            kind 'close'   (the rest is written off)
//        paid less, no close             → no adjustment, the rest stays pending
//  • A return lowers earned on the day it happens (returned); a day may therefore net below zero (a credit).
//  • Untied payments derive the per-product balance from the total (they run through all products oldest-first).
//  • Everything is done in whole paisa (integers) so 488.46 − 488.46 is exactly 0.
const C = (x) => Math.round((Number(x) || 0) * 100 + (Number(x) < 0 ? -1e-7 : 1e-7));
const M = (c) => Math.round(c) / 100;
const dstr = (d) => String(d || '').slice(0, 10);

// getOfferAllocation(sales, returns, payments) →
// {
//   days:      [{ date, earned, grossEarned, returned, received, writtenOff, pending }]          all products, oldest first
//   byProduct: { [productId]: { productId, name, earned, grossEarned, returned, received, writtenOff, pending,
//                               days: [{ date, earned, grossEarned, returned, received, writtenOff, pending }] } }
//   payments:  [{ id, date, amount, applied, excess, writtenOff, adjustment, kind }]            adjustment is signed, kind 'over' | 'close' | ''
//   adjustments: [{ paymentId, date, amount (signed), kind }]                                    the ONLY effect of a payment on profit
//   total:     { earned, grossEarned, returned, received, writtenOff, pending, paid, excess, adjustment }
// }
//   earned  = grossEarned − returned (net of returns)       pending = earned − received − writtenOff   (> 0 company owes, ≤ 0 settled / credit)
//   received = the part of the payments applied to that day (an overpayment's excess is NOT here — it is an adjustment)
function getOfferAllocation(sales, returns, payments) {
  const ev = [], names = {}, order = {};
  let seq = 0;
  const reg = (pid, name) => { if (!(pid in order)) order[pid] = seq++; if (name && !names[pid]) names[pid] = name; };
  (sales || []).forEach((s, i) => { const c = C(s.deduction); if (!s.productId) return; reg(String(s.productId), s.productName); ev.push({ t: 0, date: dstr(s.date), pid: String(s.productId), c, i }); });
  (returns || []).forEach((s, i) => { const c = C(s.reversal); if (!s.productId) return; reg(String(s.productId), s.productName); ev.push({ t: 1, date: dstr(s.date), pid: String(s.productId), c, i }); });
  (payments || []).forEach((p, i) => ev.push({ t: 2, date: dstr(p.date), p, i }));
  ev.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.t - b.t || a.i - b.i));

  const buckets = new Map();   // pid|date → { pid, date, gross, ret, rec, wo }  (cents)
  const get = (pid, date) => { const k = pid + '|' + date; let b = buckets.get(k); if (!b) { b = { pid, date, gross: 0, ret: 0, rec: 0, wo: 0 }; buckets.set(k, b); } return b; };
  const open = (b) => b.gross - b.ret - b.rec - b.wo;
  const payOut = [], adj = [], settle = [];   // settle: which payment settled which sale day (cents)

  ev.forEach((e) => {
    if (e.t === 0) { get(e.pid, e.date).gross += e.c; return; }
    if (e.t === 1) { get(e.pid, e.date).ret += e.c; return; }
    const p = e.p, amt = Math.max(0, C(p.amount));
    const ids = Array.isArray(p.productIds) ? p.productIds.map(String).filter(Boolean) : [];
    const from = dstr(p.from), to = dstr(p.to);
    const elig = [...buckets.values()].filter(b => b.date <= e.date && (!ids.length || ids.includes(b.pid)) && (!from || b.date >= from) && (!to || b.date <= to));
    const sum = elig.reduce((s, b) => s + open(b), 0), payable = Math.max(0, sum);
    const pos = elig.filter(b => open(b) > 0).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (order[a.pid] || 0) - (order[b.pid] || 0)));
    let apply = Math.min(amt, payable), left = apply;
    for (const b of pos) { if (left <= 0) break; const t = Math.min(open(b), left); b.rec += t; left -= t; settle.push({ paymentId: p.id, paymentDate: e.date, date: b.date, c: t }); }
    const excess = amt > payable ? amt - payable : 0;
    let wo = 0;
    if (p.close && amt < payable) {
      wo = payable - amt; let w = wo;
      for (const b of pos) { if (w <= 0) break; const t = Math.min(open(b), w); b.wo += t; w -= t; }
    }
    const signed = excess > 0 ? excess : (wo > 0 ? -wo : 0), kind = excess > 0 ? 'over' : (wo > 0 ? 'close' : '');
    payOut.push({ id: p.id, date: e.date, amount: M(amt), applied: M(apply), excess: M(excess), writtenOff: M(wo), adjustment: M(signed), kind });
    if (signed) adj.push({ paymentId: p.id, date: e.date, amount: M(signed), kind });
  });

  const row = (b) => ({ date: b.date, earned: M(b.gross - b.ret), grossEarned: M(b.gross), returned: M(b.ret), received: M(b.rec), writtenOff: M(b.wo), pending: M(open(b)) });
  const fold = (list) => {
    const m = {};
    list.forEach(b => { const o = m[b.date] || (m[b.date] = { date: b.date, gross: 0, ret: 0, rec: 0, wo: 0 }); o.gross += b.gross; o.ret += b.ret; o.rec += b.rec; o.wo += b.wo; });
    return Object.keys(m).sort().map(d => row(m[d]));
  };
  const all = [...buckets.values()];
  const byProduct = {};
  Object.keys(order).sort((a, b) => order[a] - order[b]).forEach(pid => {
    const mine = all.filter(b => b.pid === pid), days = fold(mine);
    const s = mine.reduce((o, b) => ({ gross: o.gross + b.gross, ret: o.ret + b.ret, rec: o.rec + b.rec, wo: o.wo + b.wo }), { gross: 0, ret: 0, rec: 0, wo: 0 });
    byProduct[pid] = Object.assign({ productId: pid, name: names[pid] || '' }, row(Object.assign({ date: '' }, s)), { days });
    delete byProduct[pid].date;
  });
  const t = all.reduce((o, b) => ({ gross: o.gross + b.gross, ret: o.ret + b.ret, rec: o.rec + b.rec, wo: o.wo + b.wo }), { gross: 0, ret: 0, rec: 0, wo: 0 });
  const total = { earned: M(t.gross - t.ret), grossEarned: M(t.gross), returned: M(t.ret), received: M(t.rec), writtenOff: M(t.wo), pending: M(t.gross - t.ret - t.rec - t.wo),
    paid: M(payOut.reduce((s, p) => s + C(p.amount), 0)), excess: M(payOut.reduce((s, p) => s + C(p.excess), 0)), adjustment: M(adj.reduce((s, a) => s + C(a.amount), 0)) };
  // settlements: which company payment settled the offer of which sale day (v14, for the profit panel) — merged per payment + sale day
  const sm = {}; settle.forEach(x => { const k = x.paymentId + '|' + x.date; (sm[k] = sm[k] || { paymentId: x.paymentId, paymentDate: x.paymentDate, date: x.date, c: 0 }).c += x.c; });
  const settlements = Object.values(sm).map(x => ({ paymentId: x.paymentId, paymentDate: x.paymentDate, date: x.date, amount: M(x.c) }));
  return { days: fold(all), byProduct, payments: payOut, adjustments: adj, settlements, total };
}

// ── turn stored transaction rows into sales / returns / quantity rows ──
// rows: transactions rows (type, date, product_id, product_name, cases, pcs, total_units, rule_case_size, rule_bonus_free_units, rule_bonus_free_money …)
// lineDeduction: the v12 helper (api/_lib/offer.js) — passed in so this file stays pure.  Only lines whose OWN snapshot carries an offer count.
const SALE_TYPES = { give: 1, point_sale: 1 };
const RETURN_TYPES = { return: 1, damage: 1, point_damage_return: 1 };
function normRows(rows, lineDeduction, opts) {
  const start = (opts && opts.start) || '';
  const sales = [], returns = [], qty = [];
  (rows || []).forEach((r) => {
    const kind = SALE_TYPES[r.type] ? 'sale' : (RETURN_TYPES[r.type] ? 'return' : '');
    if (!kind) return;
    const date = dstr(r.date); if (start && date < start) return;
    const has = r.rule_case_size !== null && r.rule_case_size !== undefined;
    const offerBearing = has && (Number(r.rule_bonus_free_units) > 0 || Number(r.rule_bonus_free_money) > 0);
    const ded = has ? lineDeduction(r) : 0;
    if (!offerBearing && !(ded > 0)) return;           // this product line never carried an offer → not part of the company ledger
    const pid = String(r.product_id || ''); if (!pid) return;
    const units = Number(r.total_units) || 0;
    const cs = Number(r.rule_case_size) > 0 ? Number(r.rule_case_size) : ((Number(r.cases) > 0) ? Math.round((units - (Number(r.pcs) || 0)) / Number(r.cases)) : 1) || 1;
    qty.push({ kind, date, productId: pid, productName: r.product_name || '', units, cases: Number(r.cases) || 0, pcs: Number(r.pcs) || 0, unitsPerCase: cs, createdAt: String(r.created_at || '') });
    if (kind === 'sale') sales.push({ date, productId: pid, productName: r.product_name || '', deduction: ded });
    else returns.push({ date, productId: pid, productName: r.product_name || '', reversal: ded });
  });
  return { sales, returns, qty };
}

// add up stored cases / loose bottles (each line keeps its OWN pieces-per-case) and carry loose bottles into cases with the latest case size
function sumQty(list, sign) {
  let cases = 0, loose = 0, ups = 0, at = '';
  list.forEach(q => { cases += (sign || 1) * q.cases; loose += (sign || 1) * q.pcs; if (q.createdAt >= at || !ups) { at = q.createdAt; ups = q.unitsPerCase || ups; } });
  ups = ups || 1;
  const bottles = Math.round(loose * 10000) / 10000, carry = Math.floor(bottles / ups + 1e-9);
  const c = cases + carry, b = Math.round((bottles - carry * ups) * 10000) / 10000;
  return { cases: c, bottles: b, units: c * ups + b, unitsPerCase: ups };
}

// buildLedger(normalized, payments, opts) → per-product ledger + totals + allocation.   opts.names: { productId: name } (optional)
//   per product: sold / returned / net (cases + bottles), since (cases + bottles after the last payment that covers the product),
//                earned (= Σ offer − return reversals), received (applied), writtenOff, balance (= earned − received − writtenOff), adjustment
function buildLedger(norm, payments, opts) {
  const alloc = getOfferAllocation(norm.sales, norm.returns, payments);
  const ids = {};
  norm.qty.forEach(q => { ids[q.productId] = q.productName || ids[q.productId] || ''; });
  Object.keys(alloc.byProduct).forEach(pid => { if (!(pid in ids)) ids[pid] = alloc.byProduct[pid].name; });
  const pays = (payments || []).slice().sort((a, b) => (dstr(a.date) < dstr(b.date) ? -1 : 1));
  const lastPayFor = (pid) => {
    let d = '';
    pays.forEach(p => { const t = Array.isArray(p.productIds) ? p.productIds.map(String).filter(Boolean) : []; if (!t.length || t.includes(pid)) { if (dstr(p.date) > d) d = dstr(p.date); } });
    return d;
  };
  const adjByPay = {}; alloc.payments.forEach(p => { adjByPay[p.id] = p; });
  const products = Object.keys(ids).map((pid) => {
    const q = norm.qty.filter(x => x.productId === pid), a = alloc.byProduct[pid] || { earned: 0, grossEarned: 0, returned: 0, received: 0, writtenOff: 0, pending: 0, days: [] };
    const sold = sumQty(q.filter(x => x.kind === 'sale')), ret = sumQty(q.filter(x => x.kind === 'return'));
    const ups = sold.unitsPerCase || ret.unitsPerCase || 1;
    const net = { cases: 0, bottles: 0, units: 0 }; net.units = Math.round((sold.units - ret.units) * 10000) / 10000;
    net.cases = Math.floor(net.units / ups + 1e-9); net.bottles = Math.round((net.units - net.cases * ups) * 10000) / 10000;
    const last = lastPayFor(pid), after = q.filter(x => !last || x.date > last);
    const s2 = sumQty(after.filter(x => x.kind === 'sale')), r2 = sumQty(after.filter(x => x.kind === 'return'));
    const su = Math.round((s2.units - r2.units) * 10000) / 10000, sc = Math.floor(su / ups + 1e-9);
    return { productId: pid, name: ids[pid], unitsPerCase: ups, sold, returned: ret, net,
      since: { from: last, cases: sc, bottles: Math.round((su - sc * ups) * 10000) / 10000, units: su },
      earned: a.earned, grossEarned: a.grossEarned, offerReturned: a.returned, received: a.received, writtenOff: a.writtenOff, balance: a.pending, days: a.days };
  }).sort((x, y) => String(x.name).localeCompare(String(y.name), 'bn'));
  return { products, total: alloc.total, days: alloc.days, payments: alloc.payments, adjustments: alloc.adjustments };
}

// report(norm, { from, to, mode, payments }) → rows for "কোম্পানিকে বিক্রয় পাঠান"
//   mode 'range' = sales dated from..to        mode 'since' = sales after the last payment that covers each product
// per product: cases + bottles (net of returns).  No SKU, no price — compact by design.
function buildReport(norm, payments, opts) {
  opts = opts || {};
  const from = dstr(opts.from), to = dstr(opts.to), mode = opts.mode === 'since' ? 'since' : 'range';
  const pays = payments || [];
  const lastPayFor = (pid) => { let d = ''; pays.forEach(p => { const t = Array.isArray(p.productIds) ? p.productIds.map(String).filter(Boolean) : []; if (!t.length || t.includes(pid)) if (dstr(p.date) > d) d = dstr(p.date); }); return d; };
  const by = {};
  norm.qty.forEach(q => { (by[q.productId] = by[q.productId] || { name: q.productName, list: [] }).list.push(q); });
  const rows = Object.keys(by).map(pid => {
    const last = mode === 'since' ? lastPayFor(pid) : '';
    const list = by[pid].list.filter(q => mode === 'since' ? (!last || q.date > last) : ((!from || q.date >= from) && (!to || q.date <= to)));
    const s = sumQty(list.filter(x => x.kind === 'sale')), r = sumQty(list.filter(x => x.kind === 'return'));
    const ups = s.unitsPerCase || r.unitsPerCase || 1, u = Math.round((s.units - r.units) * 10000) / 10000, c = Math.floor(u / ups + 1e-9);
    return { productId: pid, name: by[pid].name, cases: c, bottles: Math.round((u - c * ups) * 10000) / 10000, units: u, sinceDate: last };
  }).filter(r => r.units !== 0).sort((a, b) => String(a.name).localeCompare(String(b.name), 'bn'));
  const totalUnits = rows.reduce((s, r) => s + r.units, 0);
  return { mode, from, to, rows, totalCases: rows.reduce((s, r) => s + r.cases, 0), totalBottles: rows.reduce((s, r) => s + r.bottles, 0), totalUnits };
}

module.exports = { getOfferAllocation, normRows, buildLedger, buildReport, sumQty };
