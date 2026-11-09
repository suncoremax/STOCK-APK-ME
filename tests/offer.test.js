// Step-1 offer deduction tests — run with:  node tests/offer.test.js   (no database, no npm install: db.js is replaced by an in-memory stub)
const path = require('path'), Module = require('module');
const T = { products: [], transactions: [], biz_counters: [] };
function qb(table) {
  let rows = T[table], f = [], ord = null, lim = null;
  const api = {
    select() { return api; }, eq(c, v) { f.push(r => String(r[c]) === String(v)); return api; }, in(c, a) { f.push(r => a.map(String).includes(String(r[c]))); return api; },
    lte(c, v) { f.push(r => String(r[c]) <= String(v)); return api; }, gte(c, v) { f.push(r => String(r[c]) >= String(v)); return api; },
    order(c, o) { ord = [c, o && o.ascending === false]; return api; }, range() { return api; }, limit(n) { lim = n; return api; },
    maybeSingle() { return Promise.resolve({ data: run()[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve({ data: run(), error: null }).then(res, rej); },
    upsert(r) { const i = T[table].findIndex(x => x.business_id === r.business_id && x.key === r.key); if (i >= 0) T[table][i] = r; else T[table].push(r); return Promise.resolve({ error: null }); }
  };
  function run() { let o = rows.filter(r => f.every(g => g(r))); if (ord) o = o.slice().sort((a, b) => (String(a[ord[0]]) < String(b[ord[0]]) ? -1 : 1) * (ord[1] ? -1 : 1)); return lim ? o.slice(0, lim) : o; }
  return api;
}
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const stub = { supabase: { from: qb }, rawSupabase: { from: qb }, bizCtx: () => ({ id: 'B1' }), num, fetchAll: async (fn) => (await fn()).data };
const dbPath = path.resolve(__dirname, '../api/_lib/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stub };
const money = require('../api/_lib/money.js'), offer = require('../api/_lib/offer.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
const eq = (n, a, b) => ok(n, Math.abs(a - b) < 0.0051, [a, b]);
const UUID = i => '00000000-0000-4000-8000-00000000000' + i;
function prod(i, o) { return Object.assign({ id: UUID(i), name: 'P' + i, sku: 'S' + i, case_size: 24, case_price: 450, case_purchase_price: 400, purchase_price: 400 / 24, selling_price: +(450 / 24).toFixed(4), bonus_free_units: 0, bonus_cases_req: 1, bonus_free_money: 0, current_stock: 10000 }, o); }
function save(lines, base) { lines.forEach((l, i) => T.transactions.push(Object.assign({ id: 'x' + T.transactions.length }, money.txRow(l, Object.assign({ tx_id: base.tx_id || 'T' + T.transactions.length, created_at: new Date(Date.now() + T.transactions.length).toISOString() }, base))))); }
const run = async () => {
  // ── pure helper ──
  let c = offer.calcOfferDeduction({ casePrice: 450, unitsPerCase: 24, offerCasesReq: 1, offerFreeUnits: 1, offerFreeMoney: 15 }, 1);
  eq('T1 deduction 33.00', c.total, 33); eq('T1 shop pays 417', 450 - c.total, 417);
  c = offer.calcOfferDeduction({ casePrice: 635, unitsPerCase: 24, offerCasesReq: 1, offerFreeUnits: 2, offerFreeMoney: 0 }, 10);
  eq('T2 per case 48.85', c.perCase, 48.85); eq('T2 shop price/case 586.15', c.shopPerCase, 586.15); eq('T2 10 cases = 488.46', c.total, 488.46); eq('T2 shop pays 5861.54', 6350 - c.total, 5861.54);
  ok('T2 not 10 x rounded', c.total !== 488.5);
  c = offer.calcOfferDeduction({ casePrice: 635, unitsPerCase: 24, offerCasesReq: 1, offerFreeUnits: 2, offerFreeMoney: 0 }, Math.floor(60 / 24));
  eq('T3 2.5 cases -> 2 cases only', c.total, offer.calcOfferDeduction({ casePrice: 635, unitsPerCase: 24, offerCasesReq: 1, offerFreeUnits: 2, offerFreeMoney: 0 }, 2).total); ok('T3 qualifying 2', c.qualifyingCases === 2);
  c = offer.calcOfferDeduction({ casePrice: 635, unitsPerCase: 24, offerCasesReq: 5, offerFreeUnits: 10, offerFreeMoney: 0 }, 7);
  ok('X=5: only the full group of 5 cases', c.qualifyingCases === 5, c);
  ok('no offer -> 0', offer.calcOfferDeduction({ casePrice: 450, unitsPerCase: 24, offerCasesReq: 1, offerFreeUnits: 0, offerFreeMoney: 0 }, 5).total === 0);

  // ── start date (works with no migration) ──
  T.products = [prod(1, { case_price: 635, case_purchase_price: 605, purchase_price: +(605 / 24).toFixed(4), selling_price: +(635 / 24).toFixed(4), bonus_free_units: 2 }), prod(2, { bonus_free_units: 1, bonus_free_money: 15 }), prod(3, {})];
  ok('start unset', (await offer.getOfferStart()) === '');
  const before = await money.priceItems([{ productId: UUID(1), cases: 10, pcs: 0 }], { type: 'give', date: '2026-11-09' });
  ok('no start date -> no offer', before.ok && before.lines[0].offerDeduction === 0 && before.lines[0].revenue === 6350, before.lines[0]);
  ok('start set', (await offer.setOfferStart('2026-11-09')) === '2026-11-09' && (await offer.getOfferStart()) === '2026-11-09');
  const old = await money.priceItems([{ productId: UUID(1), cases: 10, pcs: 0 }], { type: 'give', date: '2026-11-08' });
  ok('date before start -> no offer', old.lines[0].offerDeduction === 0 && old.lines[0].revenue === 6350);

  // ── DSR give: REAL case ──
  const g = await money.priceItems([{ productId: UUID(1), cases: 10, pcs: 0 }, { productId: UUID(2), cases: 1, pcs: 0 }, { productId: UUID(3), cases: 2, pcs: 0 }], { type: 'give', date: '2026-11-09', srId: 'SR1' });
  const [l1, l2, l3] = g.lines;
  eq('give REAL deduction', l1.offerDeduction, 488.46); eq('give REAL shop pays', l1.revenue, 5861.54); eq('give REAL gross', l1.gross, 6350); ok('stock units = real bottles', l1.units === 240, l1.units);
  eq('give 450 deduction 33', l2.offerDeduction, 33); eq('give 450 revenue 417', l2.revenue, 417); ok('product w/o offer untouched', l3.offerDeduction === 0 && l3.revenue === 900);
  ok('snapshot has fields', l1.snap.sellPrice > 0 && l1.snap.buyPrice > 0 && l1.snap.unitsPerCase === 24 && l1.snap.offerCasesReq === 1 && l1.snap.offerFreeUnits === 2 && l1.snap.offerFreeMoney === 0 && l1.snap.offerDeductionTotal === l1.offerDeduction && Math.abs(l1.snap.offerDeductionPerCase - 48.85) < 0.0051, l1.snap);
  save(g.lines, { type: 'give', sr_id: 'SR1', date: '2026-11-09', tx_id: 'G1' });
  const row1 = T.transactions.find(r => r.product_id === UUID(1));
  const sn = money.snapOf(row1);
  eq('stored row derives deduction', sn.offerDeductionTotal, 488.46); eq('stored per case', sn.offerDeductionPerCase, 48.85); eq('stored shop price per case', sn.shopPricePerCase, 586.15); ok('applied flag', sn.offerApplied);

  // ── 2.5 cases ──
  const h = await money.priceItems([{ productId: UUID(1), cases: 2, pcs: 12 }], { type: 'point_sale', date: '2026-11-09', shopId: 'SH1' });
  eq('2.5 cases deduction on 2 cases only', h.lines[0].offerDeduction, 97.69); eq('2.5 cases revenue', h.lines[0].revenue, 2 * 635 + 12 * (635 / 24) - 97.69);
  const loose = await money.priceItems([{ productId: UUID(1), cases: 0, pcs: 10 }], { type: 'point_sale', date: '2026-11-09', shopId: 'SH1' });
  ok('loose bottles get none', loose.lines[0].offerDeduction === 0);

  // ── price / offer change: old rows identical ──
  const snapshotBefore = JSON.stringify(money.snapOf(row1));
  T.products[0].case_price = 700; T.products[0].selling_price = 29.1667; T.products[0].bonus_free_units = 5; T.products[0].purchase_price = 30;
  ok('old row unchanged after product edit', JSON.stringify(money.snapOf(T.transactions.find(r => r.product_id === UUID(1)))) === snapshotBefore);
  T.products[0].case_price = 635; T.products[0].selling_price = +(635 / 24).toFixed(4); T.products[0].bonus_free_units = 2; T.products[0].purchase_price = +(605 / 24).toFixed(4);

  // ── returns reverse proportionally ──
  const r1 = await money.priceItems([{ productId: UUID(1), cases: 2, pcs: 0 }], { type: 'return', srId: 'SR1', date: '2026-11-09' });
  eq('return 2 cases reverses 97.69', r1.lines[0].offerDeduction, 97.69); eq('return credit = 1270 − 97.69', r1.lines[0].revenue, 1172.31);
  ok('return keeps original snapshot', r1.lines[0].snap.offerFreeUnits === 2 && r1.lines[0].snap.unitsPerCase === 24);
  save(r1.lines, { type: 'return', sr_id: 'SR1', date: '2026-11-09', tx_id: 'R1' });
  const rr = money.snapOf(T.transactions.find(r => r.tx_id === 'R1')); eq('stored return row derives reversal', rr.offerDeductionTotal, 97.69);
  const r2_ = await money.priceItems([{ productId: UUID(1), cases: 8, pcs: 0 }], { type: 'return', srId: 'SR1', date: '2026-11-09' });
  eq('returning the rest: total reversal = full 488.46 (no drift)', r1.lines[0].offerDeduction + r2_.lines[0].offerDeduction, 488.46);
  eq('credits add back to the whole net', r1.lines[0].revenue + r2_.lines[0].revenue, 5861.54);
  const r3 = await money.priceItems([{ productId: UUID(1), cases: 0, pcs: 5 }], { type: 'return', srId: 'SR1', date: '2026-11-09' });
  ok('loose bottles back (already 2 cases returned) reverse nothing until a case breaks', r3.lines[0].offerDeduction >= 0);
  const dm = await money.priceItems([{ productId: UUID(1), cases: 1, pcs: 0 }], { type: 'damage', srId: 'SR1', date: '2026-11-09', priorExtra: { [UUID(1)]: 48 } });
  ok('damage priced at net charged price', dm.ok && dm.lines[0].revenue > 0 && dm.lines[0].revenue < 635);

  // ── shop point sale then return (fallback: latest sale of that shop) ──
  save(h.lines, { type: 'point_sale', shop_id: 'SH1', date: '2026-11-09', tx_id: 'P1' });
  const pr = await money.priceItems([{ productId: UUID(1), cases: 1, pcs: 0 }], { type: 'point_damage_return', shopId: 'SH1', date: '2026-11-09' });
  eq('shop return of 1 of 2 cases: 97.69 − 48.85 remaining = 48.84 (cumulative, no drift)', pr.lines[0].offerDeduction, 48.84);

  // ── legacy rows untouched ──
  const legacyRow = { type: 'give', product_id: UUID(1), total_units: 48, selling_price: 26.4583, purchase_price: 25.2, total_revenue: 1270, rule_case_size: null };
  const ls = money.snapOf(legacyRow); ok('legacy: no offer', ls.offerDeductionTotal === 0 && !ls.offerApplied && ls.legacy);
  const frozen = money.snapOf({ type: 'give', product_id: UUID(1), total_units: 48, selling_price: 26.4583, purchase_price: 25.2, total_revenue: 1270, rule_case_size: 24, rule_bonus_cases_req: 0, rule_bonus_free_units: 0, rule_bonus_free_money: 0 });
  ok('frozen legacy: no offer', frozen.offerDeductionTotal === 0);
  const big = money.snapOf({ type: 'give', total_units: 24000, selling_price: 26.4583, purchase_price: 25, total_revenue: 635000 - 0.1, rule_case_size: 24, rule_bonus_cases_req: 1, rule_bonus_free_units: 2, rule_bonus_free_money: 0 });
  ok('rounding noise on a huge old line is not an offer', big.offerDeductionTotal === 0, big.offerDeductionTotal);
  // sell → return of a legacy source leaves legacy return values alone
  T.transactions.push({ id: 'L1', tx_id: 'LEG', type: 'give', sr_id: 'SR9', date: '2026-10-01', product_id: UUID(3), total_units: 48, total_revenue: 900, total_cost: 800, selling_price: 18.75, purchase_price: 16.6667, rule_case_size: null, created_at: '2026-10-01T00:00:00Z' });
  const lr = await money.priceItems([{ productId: UUID(3), cases: 1, pcs: 0 }], { type: 'return', srId: 'SR9', date: '2026-10-02' });
  eq('legacy return = plain price', lr.lines[0].revenue, 450); ok('legacy return no offer', lr.lines[0].offerDeduction === 0);

  // ── switch off again ──
  await offer.setOfferStart(''); ok('switch off', (await offer.getOfferStart()) === '');
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
};
run().catch(e => { console.error(e); process.exit(1); });
