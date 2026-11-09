// Step-2 company offer ledger tests — run with:  node tests/ledger.test.js   (no database: db.js is replaced by an in-memory stub)
const path = require('path');
const T = { products: [], transactions: [], biz_counters: [], audit_log: [], user_passwords: [], businesses: [], idempotency_keys: [] };
let uid = 0;
function qb(table) {
  const rows = T[table] || (T[table] = []); let f = [], ord = null, lim = null;
  const api = {
    select() { return api; }, eq(c, v) { f.push(r => String(r[c]) === String(v)); return api; }, in(c, a) { f.push(r => a.map(String).includes(String(r[c]))); return api; },
    lte(c, v) { f.push(r => String(r[c]) <= String(v)); return api; }, gte(c, v) { f.push(r => String(r[c]) >= String(v)); return api; },
    order(c, o) { ord = [c, o && o.ascending === false]; return api; }, range() { return api; }, limit(n) { lim = n; return api; },
    maybeSingle() { return Promise.resolve({ data: run()[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve({ data: run(), error: null }).then(res, rej); },
    insert(r) { rows.push(Object.assign({ id: 'a' + (++uid), at: new Date().toISOString() }, r)); return Promise.resolve({ error: null }); },
    upsert(r) { const i = rows.findIndex(x => x.business_id === r.business_id && x.key === r.key); if (i >= 0) rows[i] = r; else rows.push(r); return Promise.resolve({ error: null }); }
  };
  function run() { let o = rows.filter(r => f.every(g => g(r))); if (ord) o = o.slice().sort((a, b) => (String(a[ord[0]]) < String(b[ord[0]]) ? -1 : 1) * (ord[1] ? -1 : 1)); return lim ? o.slice(0, lim) : o; }
  return api;
}
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const BIZ = '11111111-1111-4111-8111-111111111111';
let TODAY = '2026-11-20';
const stub = { supabase: { from: qb }, rawSupabase: { from: qb }, bizCtx: () => ({ id: BIZ }), bizStore: { run: (c, fn) => fn() }, num, str: (s, n) => String(s || '').slice(0, n), today: () => TODAY,
  fetchAll: async (fn) => (await fn()).data, safeErr: e => String(e && e.message || e), cors() { }, idemRun: async (req, res, scope, fn) => fn(), auditLog: async () => { } };
const dbPath = path.resolve(__dirname, '../api/_lib/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stub };
const money = require('../api/_lib/money.js'), offer = require('../api/_lib/offer.js'), L = require('../api/_lib/offerLedger.js'), auth = require('../api/_lib/auth.js');
const claims = require('../api/claims.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
const eq = (n, a, b) => ok(n, Math.abs(a - b) < 0.0051, [a, b]);
const UUID = i => '00000000-0000-4000-8000-00000000000' + i;
function prod(i, o) { return Object.assign({ id: UUID(i), name: 'P' + i, sku: 'S' + i, case_size: 24, case_price: 450, case_purchase_price: 400, purchase_price: 400 / 24, selling_price: +(450 / 24).toFixed(4), bonus_free_units: 0, bonus_cases_req: 1, bonus_free_money: 0, current_stock: 10000 }, o); }
function save(lines, base) { lines.forEach(l => T.transactions.push(Object.assign({ id: 'x' + T.transactions.length }, money.txRow(l, Object.assign({ tx_id: base.tx_id, created_at: new Date(Date.now() + T.transactions.length).toISOString() }, base))))); }

// call the REAL claims handler with a signed token
async function call(user, method, query, body, pin) {
  const token = user ? auth.signToken(user) : '';
  const req = { method, query: query || {}, body: body || {}, headers: { authorization: 'Bearer ' + token, 'x-business-id': BIZ } };
  let out = null, code = 200;
  const res = { setHeader() { }, status(c) { code = c; return res; }, json(p) { out = p; return res; }, end() { } };
  await claims(req, res);
  return Object.assign({ _code: code }, out);
}
const L1 = (q) => call('owner', 'GET', Object.assign({ type: 'offer', action: 'ledger' }, q || {}));
const PAY = (b) => call('owner', 'POST', { type: 'offer' }, Object.assign({ action: 'pay-add' }, b));
const prodRow = (r, id) => r.products.find(p => p.productId === UUID(id));

const run = async () => {
  T.businesses.push({ id: BIZ, name: 'T', cycle_start_day: 1 });
  T.user_passwords.push({ user_key: 'owner', password: auth.hashPin('13579'), must_change_pw: false });

  // ═════ pure helper ═════
  let a = L.getOfferAllocation([{ date: '2026-11-01', productId: 'A', deduction: 33 }], [], [{ id: 'p1', date: '2026-11-02', amount: 33 }]);
  eq('T33 earned', a.total.earned, 33); eq('T33 balance 0', a.total.pending, 0); ok('T33 no adjustment (no profit effect)', a.adjustments.length === 0 && a.total.adjustment === 0, a.adjustments);
  const s488 = [{ date: '2026-11-09', productId: 'A', deduction: 488.46 }];
  a = L.getOfferAllocation(s488, [], [{ id: 'p', date: '2026-11-10', amount: 488.46 }]); eq('REAL paid 488.46 -> balance 0', a.total.pending, 0); ok('REAL exact: no adjustment', a.adjustments.length === 0);
  a = L.getOfferAllocation(s488, [], [{ id: 'p', date: '2026-11-10', amount: 500 }]);
  eq('REAL paid 500 -> balance 0', a.total.pending, 0); ok('REAL +11.54 on the payment date', a.adjustments.length === 1 && a.adjustments[0].amount === 11.54 && a.adjustments[0].date === '2026-11-10' && a.adjustments[0].kind === 'over', a.adjustments);
  a = L.getOfferAllocation(s488, [], [{ id: 'p', date: '2026-11-10', amount: 480, close: true }]);
  ok('REAL paid 480 + close -> -8.46 on the payment date', a.adjustments.length === 1 && a.adjustments[0].amount === -8.46 && a.adjustments[0].date === '2026-11-10' && a.adjustments[0].kind === 'close', a.adjustments); eq('closed balance 0', a.total.pending, 0);
  a = L.getOfferAllocation(s488, [], [{ id: 'p', date: '2026-11-10', amount: 480 }]);
  eq('REAL paid 480 no close -> 8.46 stays pending', a.total.pending, 8.46); ok('no close: no adjustment', a.adjustments.length === 0);
  // FIFO: oldest first
  a = L.getOfferAllocation([{ date: '2026-11-03', productId: 'A', deduction: 100 }, { date: '2026-11-01', productId: 'A', deduction: 50 }, { date: '2026-11-02', productId: 'B', deduction: 70 }], [], [{ id: 'p', date: '2026-11-05', amount: 130 }]);
  const day = d => a.days.find(x => x.date === d);
  eq('FIFO day1 fully received', day('2026-11-01').received, 50); eq('FIFO day1 pending 0', day('2026-11-01').pending, 0);
  eq('FIFO day2 (other product, untied payment) 70 received', day('2026-11-02').received, 70); eq('FIFO day3 only 10 received', day('2026-11-03').received, 10); eq('FIFO day3 pending 90', day('2026-11-03').pending, 90);
  eq('untied payment: product A balance derived from the total', a.byProduct.A.pending, 90); eq('product B balance 0', a.byProduct.B.pending, 0);
  // a payment cannot settle offers of a LATER sale date
  a = L.getOfferAllocation([{ date: '2026-11-10', productId: 'A', deduction: 40 }], [], [{ id: 'p', date: '2026-11-05', amount: 40 }]);
  eq('advance payment: nothing earned yet -> all of it is an adjustment', a.total.excess, 40); eq('later offer still pending', a.total.pending, 40);
  // tied to a product
  a = L.getOfferAllocation([{ date: '2026-11-01', productId: 'A', deduction: 50 }, { date: '2026-11-01', productId: 'B', deduction: 50 }], [], [{ id: 'p', date: '2026-11-02', amount: 50, productIds: ['B'] }]);
  eq('tied payment settles only B', a.byProduct.B.pending, 0); eq('A untouched', a.byProduct.A.pending, 50);
  // a return lowers earned and balance
  a = L.getOfferAllocation(s488, [{ date: '2026-11-11', productId: 'A', reversal: 97.69 }], []);
  eq('return lowers earned', a.total.earned, 390.77); eq('return lowers balance', a.total.pending, 390.77); eq('gross earned unchanged', a.total.grossEarned, 488.46);
  // identity per day
  a = L.getOfferAllocation([{ date: '2026-11-01', productId: 'A', deduction: 10.1 }, { date: '2026-11-02', productId: 'A', deduction: 20.2 }], [{ date: '2026-11-03', productId: 'A', reversal: 3.03 }], [{ id: 'p', date: '2026-11-04', amount: 15 }, { id: 'q', date: '2026-11-05', amount: 5, close: true }]);
  ok('day identity earned = received + writtenOff + pending', a.days.every(d => Math.abs(d.earned - d.received - d.writtenOff - d.pending) < 0.0001), a.days);
  eq('total identity', a.total.earned - a.total.received - a.total.writtenOff, a.total.pending);

  // ═════ real data through the real handlers ═════
  T.products = [prod(1, { case_price: 635, case_purchase_price: 605, purchase_price: +(605 / 24).toFixed(4), selling_price: +(635 / 24).toFixed(4), bonus_free_units: 2 }), prod(2, { bonus_free_units: 1, bonus_free_money: 15 }), prod(3, {})];
  await offer.setOfferStart('2026-11-09');
  const g = await money.priceItems([{ productId: UUID(1), cases: 10, pcs: 0 }, { productId: UUID(2), cases: 1, pcs: 0 }, { productId: UUID(3), cases: 2, pcs: 0 }], { type: 'give', date: '2026-11-09', srId: 'SR1' });
  save(g.lines, { type: 'give', sr_id: 'SR1', date: '2026-11-09', tx_id: 'G1' });
  let r = await L1();
  ok('ledger ok', r.ok, r); ok('product without an offer is not in the company ledger', !prodRow(r, 3));
  eq('REAL earned 488.46', prodRow(r, 1).earned, 488.46); eq('450 product earned 33', prodRow(r, 2).earned, 33); eq('total earned 521.46', r.total.earned, 521.46);
  ok('cases / bottles sold', prodRow(r, 1).sold.cases === 10 && prodRow(r, 1).sold.bottles === 0 && prodRow(r, 1).since.cases === 10, prodRow(r, 1));
  ok('balance = earned before any payment', Math.abs(r.total.pending - 521.46) < 0.006);

  // payment 33 for product 2 → balance 33 settled, no profit effect
  r = await PAY({ amount: 33, date: '2026-11-10', note: 'bKash', productIds: [UUID(2)] });
  ok('payment saved', r.ok && r.savedId, r); eq('payment 33 settles product 2', prodRow(r, 2).balance, 0); ok('no adjustment for an exact payment', r.adjustments.length === 0, r.adjustments);
  ok('cases since the last payment restart for product 2', prodRow(r, 2).since.cases === 0 && prodRow(r, 1).since.cases === 10, [prodRow(r, 2).since, prodRow(r, 1).since]);
  const idPay1 = r.savedId;
  // REAL: pay 488.46, 500, 480+close
  r = await PAY({ amount: 488.46, date: '2026-11-11', productIds: [UUID(1)] }); eq('REAL pay 488.46 -> product balance 0', prodRow(r, 1).balance, 0); ok('REAL exact: still no adjustment', r.adjustments.length === 0);
  let idDel = r.savedId;
  const pin = '13579';
  const del = await call('owner', 'POST', { type: 'offer' }, { action: 'pay-del', id: idDel, pin: '00000' }); ok('delete asks PIN (wrong PIN refused)', !del.ok, del);
  const del2 = await call('owner', 'POST', { type: 'offer' }, { action: 'pay-del', id: idDel, pin }); ok('delete with PIN works', del2.ok && Math.abs(prodRow(del2, 1).balance - 488.46) < 0.006, del2.ok);
  r = await PAY({ amount: 500, date: '2026-11-12', productIds: [UUID(1)] });
  ok('REAL pay 500 -> +11.54 dated on the payment date', r.adjustments.length === 1 && r.adjustments[0].amount === 11.54 && r.adjustments[0].date === '2026-11-12', r.adjustments); eq('balance 0 after 500', prodRow(r, 1).balance, 0);
  const idEdit = r.savedId;
  const ed = await call('owner', 'POST', { type: 'offer' }, { action: 'pay-edit', id: idEdit, pin: '00000', amount: 480, close: true }); ok('edit asks PIN', !ed.ok);
  const ed2 = await call('owner', 'POST', { type: 'offer' }, { action: 'pay-edit', id: idEdit, pin, amount: 480, close: true });
  ok('edit to 480 + "সমন্বয় সহ বন্ধ করুন" -> -8.46 on the payment date', ed2.ok && ed2.adjustments.length === 1 && ed2.adjustments[0].amount === -8.46 && ed2.adjustments[0].date === '2026-11-12', ed2.adjustments); eq('closed -> balance 0', prodRow(ed2, 1).balance, 0);
  ok('only one payment row after the edit (no duplicate)', ed2.payments.filter(p => p.productIds.includes(UUID(1))).length === 1);

  // price / offer change alters nothing old
  const before = JSON.stringify((await L1()).products.map(p => [p.productId, p.earned, p.received, p.balance, p.sold.cases]));
  T.products[0].case_price = 900; T.products[0].selling_price = 37.5; T.products[0].bonus_free_units = 9; T.products[0].bonus_free_money = 100; T.products[1].bonus_free_units = 0; T.products[1].bonus_free_money = 0;
  ok('price / offer change: ledger identical', JSON.stringify((await L1()).products.map(p => [p.productId, p.earned, p.received, p.balance, p.sold.cases])) === before);

  // oldest settled first through the API: second sale day, then a payment smaller than both days
  T.products[0].case_price = 635; T.products[0].selling_price = +(635 / 24).toFixed(4); T.products[0].bonus_free_units = 2; T.products[0].bonus_free_money = 0;
  const g2 = await money.priceItems([{ productId: UUID(1), cases: 4, pcs: 0 }], { type: 'give', date: '2026-11-14', srId: 'SR1' });
  save(g2.lines, { type: 'give', sr_id: 'SR1', date: '2026-11-14', tx_id: 'G2' });
  r = await L1(); const p1 = prodRow(r, 1); eq('new sale adds earned 195.38', p1.earned - 488.46, 195.38); eq('only the new sale is pending', p1.balance, 195.38);
  ok('days listed oldest first, 11-09 fully settled', p1.days[0].date === '2026-11-09' && p1.days[0].pending === 0 && p1.days[1].date === '2026-11-14' && Math.abs(p1.days[1].pending - 195.38) < 0.006, p1.days);
  ok('cases since last payment = only the new 4 cases', p1.since.cases === 4, p1.since);
  // return lowers earned & balance
  const rt = await money.priceItems([{ productId: UUID(1), cases: 1, pcs: 0 }], { type: 'return', srId: 'SR1', date: '2026-11-15' });
  save(rt.lines, { type: 'return', sr_id: 'SR1', date: '2026-11-15', tx_id: 'R1' });
  r = await L1(); const p1b = prodRow(r, 1);
  ok('return lowers earned', p1b.earned < p1.earned - 40, [p1.earned, p1b.earned]); ok('return lowers balance', p1b.balance < p1.balance - 40, [p1.balance, p1b.balance]);
  ok('net cases shown after the return', p1b.net.cases === 13 && p1b.returned.cases === 1, [p1b.net, p1b.returned]);

  // report for the company
  let rep = await call('owner', 'GET', { type: 'offer', action: 'report', from: '2026-11-09', to: '2026-11-20', mode: 'range' });
  ok('report ok, compact rows', rep.ok && rep.rows.length === 2 && !('sku' in rep.rows[0]) && !('price' in rep.rows[0]), rep);
  ok('report cases + bottles for P1 (14 − 1)', rep.rows.find(x => x.productId === UUID(1)).cases === 13 && rep.rows.find(x => x.productId === UUID(1)).bottles === 0, rep.rows);
  rep = await call('owner', 'GET', { type: 'offer', action: 'report', from: '2026-11-09', to: '2026-11-20', mode: 'since' });
  ok('report "since last payment" = 4 − 1 cases', rep.rows.length === 1 && rep.rows[0].cases === 3, rep.rows);

  // ═════ roles ═════
  for (const who of ['dsr', 'so', 'DSR-1', 'shop', '']) {
    const x = await call(who, 'GET', { type: 'offer', action: 'ledger' });
    ok('blocked for "' + who + '" (ledger)', !x.ok && (x.forbidden || x.auth), x);
  }
  const bp = await call('dsr', 'POST', { type: 'offer' }, { action: 'pay-add', amount: 100, date: '2026-11-10' }); ok('DSR cannot add a payment', !bp.ok && bp.forbidden === true, bp);
  const n0 = T.audit_log.filter(x => x.table_name === 'offer_payment').length;
  await call('so', 'POST', { type: 'offer' }, { action: 'pay-add', amount: 100, date: '2026-11-10' }); ok('SO attempt wrote nothing', T.audit_log.filter(x => x.table_name === 'offer_payment').length === n0);
  const br = await call('so', 'GET', { type: 'offer', action: 'report', from: '2026-11-09', to: '2026-11-20' }); ok('SO cannot read the report', !br.ok && br.forbidden === true);
  const mg = await call('manager', 'GET', { type: 'offer', action: 'ledger' }); ok('manager allowed', mg.ok);
  const bad = await PAY({ amount: 0, date: '2026-11-10' }); ok('amount must be > 0', !bad.ok);
  const fut = await PAY({ amount: 10, date: '2027-01-01' }); ok('no future date', !fut.ok);

  await offer.setOfferStart('');
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
};
run().catch(e => { console.error(e); process.exit(1); });
