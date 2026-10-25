// End-to-end API test against a real Postgres (no Supabase needed). Run: node tests/api.test.js
const { makeDb } = require('./pgshim');
global.__BM_DB__ = makeDb({ host: '/tmp/pg', user: 'postgres', database: 'bmtest' });
process.env.SESSION_SECRET = 'test-secret';
const H = { auth: require('../api/auth'), data: require('../api/data'), ops: require('../api/ops'), reports: require('../api/reports'), system: require('../api/system') };
let pass = 0;
function ok(c, m) { if (!c) { console.error('✗ FAIL:', m); process.exitCode = 1; throw new Error(m); } pass++; }
async function call(h, method, query, body, token) {
  const req = { method, query: query || {}, body: body || {}, headers: token ? { authorization: 'Bearer ' + token } : {} };
  let out = { status: 200, json: null };
  const res = { setHeader() {}, status(c) { out.status = c; return this; }, json(j) { out.json = j; this.writableEnded = true; return this; }, end() { this.writableEnded = true; return this; } };
  await H[h](req, res);
  return Object.assign({ status: out.status }, out.json);
}
const today = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10);
(async () => {
  const pool = global.__BM_DB__.pool;
  // ── auth ──
  let r = await call('auth', 'GET', { action: 'status' });
  ok(r.needsSetup === true, 'needs setup');
  r = await call('auth', 'POST', { action: 'setup' }, { name: 'মালিক', username: 'owner', pin: '123456', business_name: 'Test Co' });
  ok(r.ok && r.token, 'setup owner');
  const O = r.token;
  r = await call('auth', 'POST', { action: 'setup' }, { name: 'x', username: 'second', pin: '1234' });
  ok(r.status === 403, 'setup only once');
  r = await call('auth', 'POST', { action: 'login' }, { username: 'owner', pin: '000000' });
  ok(r.status === 401, 'wrong pin rejected');
  r = await call('auth', 'POST', { action: 'user-save' }, { name: 'Mgr', username: 'mgr', role: 'manager', pin: '4321' }, O);
  ok(r.ok, 'create manager');
  r = await call('auth', 'POST', { action: 'login' }, { username: 'mgr', pin: '4321' });
  ok(r.ok && r.user.role === 'manager', 'manager login');
  const M = r.token;
  r = await call('auth', 'GET', { action: 'users' }, null, M); ok(r.status === 403, 'manager cannot list users');
  r = await call('data', 'GET', { t: 'products' }); ok(r.status === 401, 'no token = 401');
  r = await call('data', 'GET', { t: 'products' }, null, 'garbage.token'); ok(r.status === 401, 'bad token = 401');

  // ── master data ──
  r = await call('data', 'POST', { t: 'suppliers' }, { name: 'ABC Company', opening_payable: 1000 }, O); ok(r.ok, 'supplier');
  const SUP = r.row.id;
  r = await call('data', 'POST', { t: 'employees' }, { name: 'Karim', designation: 'DSR', salary: 12000 }, O); ok(r.ok, 'employee');
  const EMP = r.row.id;
  r = await call('data', 'POST', { t: 'products' }, { name: 'Soap', category: 'Care', case_size: 12, purchase_price: 10, selling_price: 15, low_stock: 100, opening_stock: 50 }, O); ok(r.ok, 'product');
  const P1 = r.row.id;
  r = await call('data', 'POST', { t: 'shops' }, { name: 'Rahim Store', area: 'Mirpur', opening_due: 500, credit_limit: 3000, employee_id: EMP }, M); ok(r.ok && r.row.code === 'SHOP-0001', 'shop code ' + (r.row && r.row.code));
  const SHOP = r.row.id;
  r = await call('data', 'GET', { t: 'products' }, null, O); ok(r.rows.length === 1 && Number(r.rows[0].stock) === 50, 'opening stock applied');
  r = await call('data', 'GET', { t: 'products' }, null, M); ok(r.rows[0].purchase_price === undefined, 'manager does not see cost');
  r = await call('data', 'GET', { t: 'employees' }, null, M); ok(r.rows[0].salary === undefined, 'manager does not see salary');
  r = await call('data', 'GET', { t: 'shops' }, null, M); ok(r.rows[0].balance == 500, 'shop opening due 500');
  r = await call('data', 'GET', { t: 'suppliers' }, null, M); ok(r.rows[0].balance == 1000, 'supplier opening payable');

  // ── purchase → sale → collection ──
  r = await call('ops', 'POST', { action: 'purchase' }, { supplier_id: SUP, slip_no: 'SL1', paid: 400, client_token: 'pt1', items: [{ product_id: P1, units: 100, unit_cost: 11 }] }, M);
  ok(r.ok && r.result.due === 700, 'purchase due 700');
  r = await call('ops', 'GET', { action: 'purchases' }, null, M); ok(r.rows.length === 1, 'purchase list');
  r = await call('data', 'GET', { t: 'suppliers' }, null, M); ok(r.rows[0].balance == 1700, 'payable 1700 (1000+700)');
  r = await call('ops', 'POST', { action: 'sale' }, { shop_id: SHOP, employee_id: EMP, paid: 100, discount: 10, client_token: 'st1', items: [{ product_id: P1, units: 60, unit_price: 15 }] }, M);
  ok(r.ok && r.result.total === 890 && r.result.due === 790, 'sale totals ' + JSON.stringify(r.result));
  const SALE = r.result.id;
  r = await call('ops', 'POST', { action: 'sale' }, { shop_id: SHOP, client_token: 'st1', items: [{ product_id: P1, units: 60, unit_price: 15 }] }, M); ok(r.result.duplicate, 'duplicate sale ignored');
  r = await call('ops', 'POST', { action: 'sale' }, { shop_id: SHOP, items: [{ product_id: P1, units: 9999, unit_price: 15 }] }, M); ok(!r.ok && /স্টক কম/.test(r.error), 'oversell blocked: ' + r.error);
  r = await call('ops', 'GET', { action: 'sale', id: SALE }, null, M); ok(r.items.length === 1 && r.sale.cost === undefined && r.items[0].cost_price === undefined && r.shop.name, 'sale detail hides cost for manager');
  r = await call('ops', 'GET', { action: 'sale', id: SALE }, null, O); ok(r.sale.cost == 660 && r.shop_balance === undefined && r.sale.shop_balance == 1290, 'owner sees cost ' + r.sale.cost);
  r = await call('ops', 'POST', { action: 'collect' }, { shop_id: SHOP, amount: 300, method: 'bkash', employee_id: EMP, client_token: 'c1' }, M); ok(r.ok && r.balance === 990, 'collect → balance ' + r.balance);
  r = await call('ops', 'POST', { action: 'collect' }, { shop_id: SHOP, amount: 300, method: 'bkash', client_token: 'c1' }, M); ok(r.duplicate, 'duplicate collection ignored');
  r = await call('ops', 'GET', { action: 'ledger', party_type: 'shop', party_id: SHOP }, null, M);
  ok(r.rows.length === 4 && r.balance === 990 && r.rows[r.rows.length - 1].balance === 990, 'ledger running balance');
  r = await call('ops', 'POST', { action: 'collect' }, { shop_id: SHOP, amount: 0 }, M); ok(!r.ok, 'zero collection rejected');

  // ── return / damage / claim ──
  r = await call('ops', 'POST', { action: 'adjustment' }, { kind: 'sale_return', party_id: SHOP, mode: 'credit', items: [{ product_id: P1, units: 4 }] }, M); ok(r.ok && r.result.amount === 60, 'sale return 60');
  r = await call('ops', 'POST', { action: 'adjustment' }, { kind: 'shop_damage', party_id: SHOP, mode: 'refund', method: 'cash', items: [{ product_id: P1, units: 2 }] }, M); ok(r.ok, 'damage w/ refund');
  r = await call('ops', 'POST', { action: 'adjustment' }, { kind: 'stock_adjust', items: [{ product_id: P1, units: 1 }] }, M); ok(r.status === 403, 'manager cannot adjust stock by default');
  r = await call('ops', 'POST', { action: 'adjustment' }, { kind: 'company_claim', party_id: SUP, mode: 'credit', items: [{ product_id: P1, units: 2 }] }, M); ok(r.ok, 'claim to company');
  r = await call('data', 'GET', { t: 'products' }, null, O); ok(Number(r.rows[0].stock) === 94 && Number(r.rows[0].damage_stock) === 0, 'stock 50+100-60+4=94, damage cleared: ' + r.rows[0].stock);

  // ── void rules ──
  r = await call('ops', 'POST', { action: 'sale-void' }, { id: SALE, reason: 'x' }, M); ok(r.status === 403, 'manager cannot void');
  r = await call('system', 'POST', { action: 'settings' }, { settings: { manager_can_void: true } }, M); ok(r.status === 403, 'manager cannot change settings');
  r = await call('system', 'POST', { action: 'settings' }, { settings: { manager_can_void: true, business_name: 'বদলানো', monthly_target: 100000 } }, O); ok(r.ok, 'owner settings');
  r = await call('auth', 'GET', { action: 'me' }, null, M); ok(r.settings.perms.void === true && r.settings.business_name === 'বদলানো', 'manager now may void');

  // ── money: expense, bank deposit, cashbook, day close ──
  r = await call('ops', 'POST', { action: 'expense' }, { category: 'গাড়ি/তেল', amount: 250, note: 'তেল' }, M); ok(r.ok, 'expense');
  r = await call('ops', 'POST', { action: 'cash-entry' }, { kind: 'bank_deposit', amount: 200, method: 'bank' }, M); ok(r.ok, 'bank deposit');
  r = await call('ops', 'POST', { action: 'cash-entry' }, { kind: 'owner_withdraw', amount: 50 }, M); ok(r.status === 403, 'manager cannot owner-withdraw');
  r = await call('ops', 'GET', { action: 'cashbook' }, null, M);
  r = await call('reports', 'GET', { action: 'cashbook', from: today, to: today }, null, M);
  // cash in: sale paid 100 (cash) ; collection was bkash. out: purchase 400, refund(damage 2*15=30), expense 250, deposit 200
  ok(r.r.cash_in == 100 && r.r.cash_out == 880 && r.r.bank_in == 500 && r.r.cash_close == -780, 'cashbook ' + JSON.stringify([r.r.cash_in, r.r.cash_out, r.r.bank_in, r.r.cash_close]));
  r = await call('ops', 'POST', { action: 'day-close' }, { counted_cash: -700 }, M); ok(r.ok && r.diff === 80, 'day close diff');

  // ── reports ──
  r = await call('reports', 'GET', { action: 'dashboard' }, null, O);
  ok(r.d.today.sales == 890 && r.d.receivable > 0 && r.d.low_stock.length === 1 && r.d.series.length === 7 && r.d.today.profit !== undefined, 'dashboard (owner)');
  r = await call('reports', 'GET', { action: 'dashboard' }, null, M);
  ok(r.d.today.sales == 890 && r.d.today.profit === undefined && r.d.stock_cost === undefined && r.d.stock_sell !== undefined, 'dashboard hides profit for manager');
  r = await call('reports', 'GET', { action: 'summary', from: today, to: today }, null, O); ok(r.r.net == 890 && r.r.purchases == 1100 && r.r.expenses == 250 && r.r.returns == 60, 'summary ' + JSON.stringify(r.r).slice(0, 200));
  for (const dim of ['product', 'shop', 'employee', 'category', 'area']) { r = await call('reports', 'GET', { action: 'by', dim, from: today, to: today }, null, O); ok(r.ok && r.rows.length >= 1, 'report by ' + dim); }
  r = await call('reports', 'GET', { action: 'by', dim: 'product', from: today, to: today }, null, M); ok(r.rows[0].profit === undefined, 'manager: no profit by product');
  r = await call('reports', 'GET', { action: 'dues' }, null, M); ok(r.rows.length === 1 && r.buckets.total > 0, 'dues');
  r = await call('reports', 'GET', { action: 'payables' }, null, M); ok(r.rows.length === 1, 'payables');
  r = await call('reports', 'GET', { action: 'stock' }, null, M); ok(r.r.items.length === 1 && r.r.total_sell > 0 && r.r.total_cost === undefined, 'stock report');
  r = await call('reports', 'GET', { action: 'summary', from: '2026-12-01', to: '2026-01-01' }, null, O); ok(!r.ok, 'bad range rejected');

  // ── staff ──
  r = await call('ops', 'POST', { action: 'attendance' }, { rows: [{ employee_id: EMP, date: today, status: 'absent' }] }, M); ok(r.saved === 1, 'attendance (manager ok)');
  r = await call('ops', 'GET', { action: 'salary-month' }, null, M); ok(r.status === 403, 'manager blocked from salary');
  r = await call('ops', 'GET', { action: 'salary-month', month: today.slice(0, 7) }, null, O); ok(r.rows[0].absent == 1 && Number(r.rows[0].deduction) === 400, 'salary deduction 12000/30');
  r = await call('ops', 'POST', { action: 'salary-pay' }, { employee_id: EMP, kind: 'advance', amount: 1000 }, O); ok(r.ok, 'advance');
  r = await call('ops', 'GET', { action: 'salary-month', month: today.slice(0, 7) }, null, O); ok(r.rows[0].advance == 1000, 'advance counted');

  // ── void by manager (now allowed), stock returns ──
  r = await call('ops', 'POST', { action: 'sale-void' }, { id: SALE, reason: 'ভুল এন্ট্রি' }, M); ok(r.ok, 'void allowed after setting');
  r = await call('data', 'GET', { t: 'products' }, null, O); ok(Number(r.rows[0].stock) === 154, 'stock after void = ' + r.rows[0].stock);
  r = await call('ops', 'GET', { action: 'sales', status: 'void' }, null, O); ok(r.rows.length === 1, 'void listed');
  r = await call('ops', 'GET', { action: 'sales', q: 'Rahim' }, null, O); ok(r.ok, 'sales search');

  // ── delete rules ──
  r = await call('data', 'DELETE', { t: 'products', id: P1 }, null, O); ok(r.ok && r.deactivated, 'used product is deactivated, not deleted');
  r = await call('data', 'POST', { t: 'notices' }, { title: 'নোটিশ ১', body: 'হ্যালো', pinned: true }, O); ok(r.ok, 'notice');
  r = await call('data', 'POST', { t: 'contacts' }, { name: 'Supplier rep', phone: '017' }, M); ok(r.ok, 'contact');

  // ── system ──
  r = await call('system', 'POST', { action: 'import' }, { type: 'products', rows: [{ name: 'Tea', purchase_price: 100, selling_price: 120, case_size: 24, stock: 10 }, { name: '' }] }, O); ok(r.imported === 1 && r.errors.length === 1, 'import products');
  r = await call('system', 'POST', { action: 'import' }, { type: 'shops', rows: [{ name: 'S2', opening_due: 100 }] }, M); ok(r.imported === 1, 'import shops');
  r = await call('system', 'GET', { action: 'backup' }, null, M); ok(r.status === 403, 'backup owner-only');
  r = await call('system', 'GET', { action: 'backup' }, null, O); ok(r.backup.tables.sales.length === 1 && r.backup.tables.products.length === 2, 'backup content');
  r = await call('system', 'POST', { action: 'resync-stock' }, {}, O); ok(r.ok, 'resync');
  r = await call('data', 'GET', { t: 'products', all: '1' }, null, O); ok(Number(r.rows.find((x) => x.name === 'Soap').stock) === 154, 'resync keeps stock');
  r = await call('system', 'GET', { action: 'audit' }, null, O); ok(r.rows.length > 10, 'audit log has entries');
  r = await call('system', 'POST', { action: 'reset' }, { keys: ['money'], confirm: 'RESET', pin: '999999' }, O); ok(!r.ok, 'reset needs correct pin');
  r = await call('system', 'POST', { action: 'reset' }, { keys: ['money'], confirm: 'RESET', pin: '123456' }, O); ok(r.ok, 'reset money');
  r = await call('ops', 'GET', { action: 'expenses' }, null, O); ok(r.rows.length === 0, 'expenses cleared');
  r = await call('system', 'POST', { action: 'reset' }, { keys: ['transactions'], confirm: 'RESET', pin: '123456' }, O); ok(r.ok, 'reset transactions');
  r = await call('data', 'GET', { t: 'products', all: '1' }, null, O); ok(r.rows.every((x) => Number(x.stock) === 0), 'stock zeroed after reset');
  r = await call('auth', 'POST', { action: 'change-pin' }, { old: '123456', new: '2468' }, O); ok(r.ok, 'change pin');
  r = await call('auth', 'POST', { action: 'login' }, { username: 'owner', pin: '2468' }); ok(r.ok, 'login with new pin');
  console.log(`\n✔ ${pass} API checks passed`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
