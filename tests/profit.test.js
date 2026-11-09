// Step-3 profit panel / dashboard / report / role-safety tests — run with:  node tests/profit.test.js
// No database, no npm install: '@supabase/supabase-js' is replaced by an in-memory client, the REAL db.js / money.js / offer*.js / profit.js / handlers run.
const Module = require('module');
const T = {};
let uid = 0;
function qb(table) {
  const rows = T[table] || (T[table] = []); let f = [], ord = null, lim = null;
  const api = {
    select() { return api; }, eq(c, v) { f.push(r => r[c] === undefined && c === 'business_id' ? true : String(r[c]) === String(v)); return api; }, neq(c, v) { f.push(r => String(r[c]) !== String(v)); return api; },
    is(c, v) { f.push(r => (r[c] === undefined || r[c] === null) === (v === null)); return api; },
    in(c, a) { f.push(r => a.map(String).includes(String(r[c]))); return api; }, lte(c, v) { f.push(r => String(r[c]).slice(0, 10) <= String(v)); return api; }, gte(c, v) { f.push(r => String(r[c]).slice(0, 10) >= String(v)); return api; },
    order(c, o) { ord = [c, o && o.ascending === false]; return api; }, range() { return api; }, limit(n) { lim = n; return api; },
    maybeSingle() { return Promise.resolve({ data: run()[0] || null, error: null }); }, single() { return Promise.resolve({ data: run()[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve({ data: run(), error: null }).then(res, rej); },
    insert(r) { (Array.isArray(r) ? r : [r]).forEach(x => rows.push(Object.assign({ id: 'a' + (++uid), at: new Date().toISOString() }, x))); return Promise.resolve({ error: null }); },
    upsert(r) { const i = rows.findIndex(x => x.business_id === r.business_id && x.key === r.key); if (i >= 0) rows[i] = r; else rows.push(r); return Promise.resolve({ error: null }); }
  };
  function run() { let o = rows.filter(r => f.every(g => g(r))); if (ord) o = o.slice().sort((a, b) => (String(a[ord[0]]) < String(b[ord[0]]) ? -1 : 1) * (ord[1] ? -1 : 1)); return lim ? o.slice(0, lim) : o; }
  return api;
}
const client = { from: qb, rpc: () => Promise.resolve({ data: null, error: { message: 'function does not exist' } }), storage: {} };
const origLoad = Module._load;
Module._load = function (req, ...a) { if (req === '@supabase/supabase-js') return { createClient: () => client }; return origLoad.call(this, req, ...a); };

const money = require('../api/_lib/money.js'), offer = require('../api/_lib/offer.js'), auth = require('../api/_lib/auth.js'), P = require('../api/_lib/profit.js');
const deposits = require('../api/deposits.js'), dashboard = require('../api/dashboard.js'), report = require('../api/report.js'), claims = require('../api/claims.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
const eq = (n, a, b) => ok(n, Math.abs(a - b) < 0.0051, [a, b]);
const BIZ = '11111111-1111-4111-8111-111111111111', UUID = i => '00000000-0000-4000-8000-00000000000' + i;
const prod = (i, o) => Object.assign({ id: UUID(i), name: 'P' + i, sku: 'S' + i, case_size: 24, case_price: 450, case_purchase_price: 300, purchase_price: 300 / 24, selling_price: +(450 / 24).toFixed(4), bonus_free_units: 1, bonus_cases_req: 1, bonus_free_money: 15, current_stock: 10000, sort_order: i }, o);
const save = (lines, base) => lines.forEach(l => (T.transactions = T.transactions || []).push(Object.assign({ id: 'x' + T.transactions.length }, money.txRow(l, Object.assign({ tx_id: base.tx_id, created_at: new Date(Date.now() + T.transactions.length).toISOString() }, base)))));
const payEvent = (id, date, amount, close) => (T.audit_log = T.audit_log || []).push({ id: 'e' + (++uid), at: new Date().toISOString(), table_name: 'offer_payment', action: 'offer_pay_add', row_id: '00000000-0000-4000-8000-0000000000' + String(10 + id), new_data: { ts: Date.now() + uid, payment: { date, amount, note: 'N' + id, productIds: [], from: '', to: '', close: !!close } } });
async function call(h, user, query, method) {
  const req = { method: method || 'GET', query: query || {}, body: {}, headers: { authorization: 'Bearer ' + auth.signToken(user), 'x-business-id': BIZ } };
  let out = null, code = 200; const res = { setHeader() { }, status(c) { code = c; return res; }, json(p) { out = p; return res; }, end() { } };
  await h(req, res); return Object.assign({ _code: code }, out);
}
const D1 = '2026-01-05', D2 = '2026-01-06', D3 = '2026-01-07', D4 = '2026-01-08';

const run = async () => {
  T.businesses = [{ id: BIZ, name: 'T', cycle_start_day: 1 }]; T.user_passwords = [{ user_key: 'owner', password: auth.hashPin('13579'), must_change_pw: false }];
  T.products = [prod(1), prod(2, { case_price: 635, case_purchase_price: 605, purchase_price: +(605 / 24).toFixed(4), selling_price: +(635 / 24).toFixed(4), bonus_free_units: 2, bonus_free_money: 0 })];
  await offer.setOfferStart('2026-01-01');

  // ═════ TEST 450 / 300 / 33, 10 cases ═════
  const g = await money.priceItems([{ productId: UUID(1), cases: 10, pcs: 0 }], { type: 'give', date: D1, srId: 'SR1' });
  save(g.lines, { type: 'give', sr_id: 'SR1', date: D1, tx_id: 'G1' });
  let p = await P.computeProfitFull(D1, D1);
  eq('450/300/33: total 1,500', p.totalProfit, 1500); eq('cash 1,170', p.cashProfit, 1170); eq('offer 330', p.offerProfit, 330); eq('offer pending 330 (বাকি)', p.offerPending, 330); eq('offer received 0', p.offerReceived, 0);
  eq('normal sales 4,500', p.normalSales, 4500); eq('offer deduction 330', p.offerDeduction, 330); eq('actual sales 4,170', p.actualSales, 4170); eq('purchase cost 3,000', p.purchaseCost, 3000);
  eq('panel 1,500 = 1,170 + 330', p.cashProfit + p.offerProfit, p.totalProfit);

  // ═════ company payment 3,000 the same day → profit unchanged, only the label moves ═════
  payEvent(1, D1, 330);
  p = await P.computeProfitFull(D1, D1);
  eq('paid 330 → total unchanged 1,500', p.totalProfit, 1500); eq('cash unchanged', p.cashProfit, 1170); eq('offer pending 0', p.offerPending, 0); eq('offer received 330', p.offerReceived, 330);
  ok('range shows which payment settled it', p.offerSettledBy.length === 1 && p.offerSettledBy[0].amount === 330 && p.offerSettledBy[0].date === D1, p.offerSettledBy);
  eq('adjustment 0 on exact payment', p.offerAdjustment, 0);

  // ═════ REAL: 635 / 605 / 24 / 2 free, 10 cases ═════
  const g2 = await money.priceItems([{ productId: UUID(2), cases: 10, pcs: 0 }], { type: 'give', date: D2, srId: 'SR1' });
  save(g2.lines, { type: 'give', sr_id: 'SR1', date: D2, tx_id: 'G2' });
  p = await P.computeProfitFull(D2, D2);
  eq('REAL actual sales 5,861.54', p.actualSales, 5861.54); eq('REAL purchase 6,050.00', p.purchaseCost, 6050); eq('REAL cash profit -188.46', p.cashProfit, -188.46); ok('cash profit negative (red)', p.cashProfit < 0);
  eq('REAL offer 488.46', p.offerProfit, 488.46); eq('REAL offer pending (বাকি)', p.offerPending, 488.46); eq('REAL TOTAL 300.00', p.totalProfit, 300); eq('REAL normal sales 6,350', p.normalSales, 6350);
  // ═════ company payment 3,000 the same day → profit unchanged, offer balance −3,000 ═════
  // (the company owes a lot more than 3,000: a 100-case sale on D3 earns 4,884.60)
  const g3 = await money.priceItems([{ productId: UUID(2), cases: 100, pcs: 0 }], { type: 'give', date: D3, srId: 'SR1' });
  save(g3.lines, { type: 'give', sr_id: 'SR1', date: D3, tx_id: 'G3' });
  const t0 = await P.computeProfitFull(D3, D3), owed0 = (await P.offerRange(D1, D4)).owed;
  eq('D3 offer earned 4,884.62', t0.offerProfit, 4884.62);
  payEvent(2, D3, 3000);
  const t1 = await P.computeProfitFull(D3, D3), owed1 = (await P.offerRange(D1, D4)).owed;
  eq('3,000 payment → day profit unchanged', t1.totalProfit, t0.totalProfit); eq('cash profit unchanged', t1.cashProfit, t0.cashProfit); eq('no adjustment (paid < owed)', t1.offerAdjustment, 0);
  eq('offer balance moves by exactly -3,000', owed1 - owed0, -3000);
  p = await P.computeProfitFull(D2, D2);
  eq('REAL D2 total still 300 after the payment settled it', p.totalProfit, 300); eq('REAL D2 offer now received (label only)', p.offerPending, 0); eq('REAL D2 cash profit still -188.46', p.cashProfit, -188.46);
  ok('REAL D2: shows the payment that settled it', p.offerSettledBy.length === 1 && p.offerSettledBy[0].date === D3, p.offerSettledBy);
  eq('D1 unaffected', (await P.computeProfitFull(D1, D1)).totalProfit, 1500);

  // ═════ price change tomorrow → yesterday identical ═════
  const snap = JSON.stringify(await P.computeProfitFull(D1, D2));
  T.products[0].case_price = 999; T.products[0].selling_price = 999 / 24; T.products[0].purchase_price = 50; T.products[0].bonus_free_units = 9;
  ok('price/offer change → past profit identical', JSON.stringify(await P.computeProfitFull(D1, D2)) === snap);
  const memo = money.txRow; ok('stored lines keep their own snapshot', T.transactions[0].selling_price != null);

  // ═════ month = sum of dailies, before and after a payment ═════
  const sumDaily = async () => { let s = 0; for (const d of [D1, D2, D3, D4]) s += (await P.computeProfitFull(d, d)).totalProfit; return s; };
  eq('range total = Σ daily', (await P.computeProfitFull(D1, D4)).totalProfit, await sumDaily());
  // overpayment: the difference only, on the payment date
  const owedNow = (await P.offerRange(D1, D4)).owed;
  payEvent(4, D4, owedNow + 100);
  eq('overpayment +100 adjustment on D4 only', (await P.computeProfitFull(D4, D4)).offerAdjustment, 100); eq('D4 total = adjustment only', (await P.computeProfitFull(D4, D4)).totalProfit, 100);
  eq('range = Σ daily after overpayment', (await P.computeProfitFull(D1, D4)).totalProfit, await sumDaily());

  // ═════ report handler: daily rows, Σ daily = range, company payments listed, not counted as sales/profit ═════
  const rep = await call(report, 'owner', { from: D1, to: D4 });
  ok('report ok', rep.ok, rep); if (rep.ok) {
    eq('report Σ daily totalProfit = range total', rep.byDate.reduce((s, d) => s + d.totalProfit, 0), rep.profit.totalProfit);
    ok('report lists company payments', rep.companyPayments.length === 3 && Math.abs(rep.companyPayTotal - (330 + 3000 + owedNow + 100)) < 0.01, rep.companyPayments);
    eq('company payments are not sales', rep.byDate.reduce((s, d) => s + d.sale, 0), 4170 + 5861.54 + 100 * 635 - 4884.62);
    ok('offer owed shown', typeof rep.offerOwed === 'number');
    ok('daily rows carry cash / offer / adjustment', rep.byDate.every(d => 'cashProfit' in d && 'offerProfit' in d && 'offerAdjustment' in d));
  }
  const dash = await call(dashboard, 'owner');
  ok('dashboard ok + offerOwed for owner', dash.ok && typeof dash.offerOwed === 'number', dash.error);
  if (dash.ok) ok('dashboard today stats carry company payments + total profit', 'totalProfit' in dash.cycleStats && 'companyPay' in dash.cycleStats);

  // ═════ ROLES: DSR / SO see no profit / ledger / payments / offer balance (API) ═════
  for (const role of ['dsr', 'so']) {
    const r1 = await call(report, role, { from: D1, to: D4 });
    ok(role + ' report → 403', r1._code === 403 && r1.forbidden, r1._code);
    const r2 = await call(claims, role, { type: 'offer', action: 'ledger' }); ok(role + ' ledger → 403', r2._code === 403);
    const rd = await call(deposits, role, {}); ok(role + ' deposits → 403', rd._code === 403);
    const rr = await call(claims, role, { type: 'receivable' }); ok(role + ' company receivable → 403', rr._code === 403);
    const r3 = await call(dashboard, role);
    const txt = JSON.stringify(r3);
    ok(role + ' dashboard has no profit / offer / ledger / payment keys', r3.ok && !/profit|offer|ledger|companyPay|receivable|buyPrice|purchasePrice/i.test(txt), txt.match(/"[a-zA-Z]*(profit|offer|ledger|companyPay|receivable|buyPrice|purchasePrice)[a-zA-Z]*"/gi));
    ok(role + ' still gets cash / due', r3.ok && 'cashTotal' in r3.todayStats && Array.isArray(r3.dsrs));
  }
  const sc = P.scrub({ a: 1, snapshot: { sellPrice: 10, buyPrice: 5, offerDeductionTotal: 3 }, offerDeduction: 3, list: [{ finalProfit: 1, price: 4 }] });
  ok('scrub removes secrets, keeps price', sc.snapshot.sellPrice === 10 && !('buyPrice' in sc.snapshot) && !('offerDeduction' in sc) && !('finalProfit' in sc.list[0]) && sc.list[0].price === 4, sc);
  ok('owner response keeps profit', JSON.stringify(dash).includes('totalProfit'));
  console.log((fail ? 'FAILED ' : 'ALL OK ') + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
};
require('../api/_lib/db.js').bizStore.run({ id: BIZ, name: 'T', cycleDay: 1 }, run).catch(e => { console.log('ERROR', e); process.exit(1); });
