// api/_lib/db.js — AXIION DMS (manual / owner-only edition)
// Shared database client + every calculation helper. Calculation rules are the same as the original DMS.
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
// ── Pagination-safe full-table fetch ──────────────────────────────────
// PostgREST (Supabase's REST layer) silently caps any query at 1000 rows
// by default — no error, it just returns the first page. Anything that
// needs an ALL-TIME aggregate MUST use this instead of a bare
// `await supabase.from(...).select(...)`.
// `queryFactory` must be a FUNCTION that returns a fresh query builder
// each call (so `.range()` can be re-applied per page).
//
// v5.1 (PERF-2): the first page is fetched ALONE. A 5-row result now costs
// exactly ONE database request (it used to fire four). Only when the first
// page is completely full (1000 rows) are further pages fetched, then in
// parallel batches. Pages are ordered by a total order (`id` tiebreaker) so
// no row is skipped/repeated at a page boundary.
const FETCH_ALL_PAGE_SIZE = 1000;
const FETCH_ALL_PARALLEL  = 4;
async function fetchAll(queryFactory, opts) {
  const tie = (opts && opts.tiebreak !== undefined) ? opts.tiebreak : 'id';
  const page = async (i) => {
    let q = queryFactory();
    if (tie) q = q.order(tie, { ascending: true });
    const from = i * FETCH_ALL_PAGE_SIZE;
    const { data, error } = await q.range(from, from + FETCH_ALL_PAGE_SIZE - 1);
    if (error) throw error;
    return data || [];
  };
  const all = [];
  const first = await page(0);
  for (let k = 0; k < first.length; k++) all.push(first[k]);
  if (first.length < FETCH_ALL_PAGE_SIZE) return all;
  let i = 1;
  while (true) {
    const idx = Array.from({ length: FETCH_ALL_PARALLEL }, (_, k) => i + k);
    const pages = await Promise.all(idx.map(page));
    let done = false;
    for (const rows of pages) {
      for (let k = 0; k < rows.length; k++) all.push(rows[k]);
      if (rows.length < FETCH_ALL_PAGE_SIZE) { done = true; break; }
    }
    if (done) break;
    i += FETCH_ALL_PARALLEL;
  }
  return all;
}

// v5.1 (PERF-1) — REAL server-side paging for list screens.
// ?page=1&pageSize=50  (pageSize capped at 200).  Returns {page,pageSize,from,to}
// where from/to are the inclusive .range() bounds. When the caller sends no
// `page` at all, returns null so old clients keep getting the full list.
function pageParams(query, defaultSize) {
  if (!query || query.page === undefined || query.page === '') return null;
  const page = Math.max(1, Math.floor(Number(query.page)) || 1);
  const pageSize = Math.min(200, Math.max(1, Math.floor(Number(query.pageSize)) || defaultSize || 50));
  return { page, pageSize, from: (page - 1) * pageSize, to: page * pageSize - 1 };
}

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function ds(v)  { if (!v) return ''; return String(v).slice(0, 10); }
// v5.1 (CALC-4): "today" is ALWAYS the Asia/Dhaka calendar day. The old UTC
// version returned yesterday between 00:00 and 06:00 Dhaka time.
function today(){ return bdtDateStr(new Date()); }
function now_() { return new Date().toISOString(); }
function str(v, max = 255) { return String(v || '').trim().slice(0, max); }
// ── Asia/Dhaka date helpers (V30 — Daily Report generation) ──────────
// The company operates in Bangladesh; "today"/"yesterday" for report
// generation must follow Asia/Dhaka local time, not the server's UTC
// clock, so the 02:00 auto-generate cron always closes out the correct
// local calendar day regardless of which UTC region Vercel runs it in.
function bdtDateStr(d) {
  d = d || new Date();
  // en-CA locale formats as YYYY-MM-DD, exactly what we need.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function bdtToday() { return bdtDateStr(new Date()); }
function addDaysStr(dateStr, delta) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
function bdtYesterday() { return addDaysStr(bdtToday(), -1); }
// ── "Salary/Target Month" cycle (V41 update 7) ────────────────────────
// Every monthly calculation in the app (salary, targets, reports, the
// bonus/damage cycle) is scoped NOT to the plain calendar month but to a
// company pay-cycle that runs from the 26th of the previous month through
// the 25th of the "labeled" month — e.g. period "2026-06" ("June") covers
// 2026-05-26 → 2026-06-25. Every place that used to store/query a plain
// 'YYYY-MM' calendar month (salary_settings.month, targets.period,
// product_targets.period, advance_requests.month, ...) keeps the exact
// same 'YYYY-MM' text format — only the date range that label refers to
// has changed, so no schema/data migration is needed, only application
// logic. These helpers are the single source of truth for that mapping;
// every API file that deals with a monthly period should go through them
// instead of re-deriving calendar-month bounds itself.
function cyclePeriodBounds(period) {
  // period = 'YYYY-MM', the label of the month the cycle's 25th falls in.
  const [y, m] = String(period).split('-').map(Number);
  let py = y, pm = m - 1;
  if (pm < 1) { pm = 12; py -= 1; }
  const start = `${py}-${String(pm).padStart(2, '0')}-26`;
  const end   = `${y}-${String(m).padStart(2, '0')}-25`;
  return { start, end };
}
function cyclePeriodForDate(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (d <= 25) return `${y}-${String(m).padStart(2, '0')}`;
  let ny = y, nm = m + 1;
  if (nm > 12) { nm = 1; ny += 1; }
  return `${ny}-${String(nm).padStart(2, '0')}`;
}
function cyclePeriodToday() { return cyclePeriodForDate(bdtToday()); }
// Every ISO date string in a cycle period, inclusive, in order.
function cyclePeriodDates(period) {
  const { start, end } = cyclePeriodBounds(period);
  const dates = [];
  let cur = start;
  while (cur <= end) { dates.push(cur); cur = addDaysStr(cur, 1); }
  return dates;
}
function safeErr(e) {
  if (process.env.NODE_ENV === 'development') return e.message;
  const msg = String(e.message || '');
  if (msg.includes('STOCK_NEGATIVE')) return 'স্টকে পর্যাপ্ত পণ্য নেই — স্টকের চেয়ে বেশি দেওয়া/বিক্রি করা যাবে না';
  if (msg.includes('duplicate') || msg.includes('unique')) return 'এই তথ্য ইতিমধ্যে আছে';
  if (msg.includes('foreign key') || msg.includes('violates')) return 'সম্পর্কিত তথ্য পাওয়া যায়নি';
  if (msg.includes('not found') || msg.includes('PGRST116')) return 'তথ্য পাওয়া যায়নি';
  return 'সার্ভার সমস্যা হয়েছে, আবার চেষ্টা করুন';
}

// ───────────────────────── row mappers ─────────────────────────
function mapProduct(r) {
  return {
    id: String(r.id || ''),
    name: r.name || '',
    sku: r.sku || '',
    caseSize: String(r.case_size || 1),
    unitType: r.unit_type || 'কেস',
    // casePrice / casePurchasePrice: source-of-truth bulk (case/jar/poly)
    // prices the owner actually types (AXIION §7 — reverse price entry).
    // purchasePrice / sellingPrice below are the derived per-piece values,
    // computed server-side in products.js, that every transaction uses.
    casePrice: String(r.case_price || 0),
    casePurchasePrice: String(r.case_purchase_price || 0),
    purchasePrice: String(r.purchase_price || 0),
    sellingPrice: String(r.selling_price || 0),
    bonusFreeUnits: String(r.bonus_free_units || 0),
    bonusCasesReq: String(r.bonus_cases_req || 1),
    bonusFreeMoney: String(r.bonus_free_money || 0),
    lowStockAlert: String(r.low_stock_alert || 0),
    thumb: r.thumb || '',
    category: r.category || '',
    sortOrder: r.sort_order != null ? Number(r.sort_order) : 0,
    // V40: running stock balance, maintained by a database trigger
    // (trg_apply_stock_delta) on every transaction insert. Read this
    // directly instead of re-fetching/re-summing full transaction
    // history — see migration_v40_stock_balance.sql.
    currentStock: num(r.current_stock),
    createdAt: r.created_at || ''
  };
}
function mapSR(r) {
  return {
    id: String(r.id || ''), name: r.name || '', phone: r.phone || '', area: r.area || '',
    role: r.role || 'dsr',
    // displayNo: stable per-role numbering (DSR-1, DSR-2 …), assigned once, never reused
    displayNo: r.display_no != null ? Number(r.display_no) : null,
    createdAt: r.created_at || ''
  };
}
function mapShop(r) {
  return {
    id: String(r.id || ''), shopNo: r.shop_no || '', name: r.name || '', keeperName: r.keeper_name || '',
    phone: r.phone || '', address: r.address || '',
    assignedDsrId: String(r.assigned_dsr_id || ''), assignedDsrName: r.assigned_dsr_name || '',
    createdAt: r.created_at || ''
  };
}
function mapTx(r) {
  return {
    txId: String(r.tx_id || ''),
    type: r.type || '',
    srId: String(r.sr_id || ''),
    srName: r.sr_name || '',
    date: r.date ? String(r.date).slice(0, 10) : '',
    slipNo: r.slip_no || '',
    productId: String(r.product_id || ''),
    productName: r.product_name || '',
    sku: r.sku || '',
    cases: String(r.cases || 0),
    pcs: String(r.pcs || 0),
    totalUnits: String(r.total_units || 0),
    purchasePrice: String(r.purchase_price || 0),
    sellingPrice: String(r.selling_price || 0),
    totalCost: String(r.total_cost || 0),
    totalRevenue: String(r.total_revenue || 0),
    // V35 — per-item commission/discount, persisted on 'dsr_sale' rows so
    // the DSR Payment page can total today's commission/discount per DSR.
    commissionAmt: String(r.commission_amt || 0),
    discountAmt: String(r.discount_amt || 0),
    // shop_id (Update #49/#51): links a row to a registered shop, when
    // there is one — was already a column on `transactions` but never
    // exposed to the JS side before.
    shopId: String(r.shop_id || ''),
    // customer_id (Update #51): links a point-sale row to a proper
    // pos_customers record when the walk-in customer isn't an existing
    // registered shop.
    customerId: String(r.customer_id || ''),
    note: r.note || '',
    createdAt: r.created_at || ''
  };
}
function mapDmg(r) {
  return {
    id: String(r.id || ''),
    txId: String(r.tx_id || ''),
    productId: String(r.product_id || ''),
    productName: r.product_name || '',
    sku: r.sku || '',
    totalUnits: String(r.total_units || 0),
    purchasePrice: String(r.purchase_price || 0),
    totalCost: String(r.total_cost || 0),
    date: r.date ? String(r.date).slice(0, 10) : '',
    srId: String(r.sr_id || ''),
    srName: r.sr_name || '',
    status: r.status || 'pending',
    clearedDate: r.cleared_date ? String(r.cleared_date).slice(0, 10) : '',
    createdAt: r.created_at || ''
  };
}

function mapBonus(r) {
  return {
    id: String(r.id || ''),
    productId: String(r.product_id || ''),
    productName: r.product_name || '',
    sku: r.sku || '',
    fromDate: r.from_date ? String(r.from_date).slice(0, 10) : '',
    toDate: r.to_date ? String(r.to_date).slice(0, 10) : '',
    givenUnits: String(r.given_units || 0),
    bonusAmount: String(r.bonus_amount || 0),
    status: r.status || '',
    clearedDate: r.cleared_date ? String(r.cleared_date).slice(0, 10) : '',
    note: r.note || '',
    createdAt: r.created_at || ''
  };
}

function mapPayment(r) {
  return {
    id: String(r.id || ''),
    srId: String(r.sr_id || ''),
    srName: r.sr_name || '',
    date: r.date ? String(r.date).slice(0, 10) : '',
    amount: String(r.amount || 0),
    cashAmount: String(r.cash_amount || 0),
    commissionAmt: String(r.commission_amt || 0),
    discountAmt: String(r.discount_amt || 0),
    damageAmt: String(r.damage_amt || 0),
    note: r.note || '',
    createdAt: r.created_at || ''
  };
}

function mapExpCat(r) {
  return { id: String(r.id || ''), name: r.name || '', createdAt: r.created_at || '' };
}
function mapExpRecord(r) {
  return {
    id: String(r.id || ''),
    categoryId: String(r.category_id || ''),
    categoryName: r.category_name || '',
    date: r.date ? String(r.date).slice(0, 10) : '',
    amount: String(r.amount || 0),
    note: r.note || '',
    createdAt: r.created_at || ''
  };
}
function mapDue(r) {
  return {
    id: String(r.id || ''), dsrId: String(r.dsr_id || ''), dsrName: r.dsr_name || '',
    clientType: r.client_type || 'shop', shopId: String(r.shop_id || ''), shopName: r.shop_name || '',
    dueDate: r.due_date ? String(r.due_date).slice(0, 10) : '',
    entryDate: r.entry_date ? String(r.entry_date).slice(0, 10) : (r.created_at ? String(r.created_at).slice(0, 10) : ''),
    amount: String(r.amount || 0), paidAmount: String(r.paid_amount || 0), initialPaid: String(r.initial_paid || 0),
    note: r.note || '', status: r.status || 'pending',
    clearedDate: r.cleared_date ? String(r.cleared_date).slice(0, 10) : '',
    createdAt: r.created_at || '', txId: String(r.tx_id || '')
  };
}
function mapSlip(r) {
  const n = (v) => Number(v) || 0;
  return {
    id: String(r.id || ''), slipNo: r.slip_no || '', dsrId: String(r.dsr_id || ''), dsrName: r.dsr_name || '',
    date: r.date ? String(r.date).slice(0, 10) : '',
    givenAmt: n(r.given_amt), returnAmt: n(r.return_amt), damageAmt: n(r.damage_amt),
    commAmt: n(r.comm_amt), discAmt: n(r.disc_amt), expectedCash: n(r.expected_cash), cashAmt: n(r.cash_amt),
    dueBefore: n(r.due_before), dueAfter: n(r.due_after), note: r.note || '',
    returnTxId: r.return_tx_id || '', damageTxId: r.damage_tx_id || '', paymentId: r.payment_id || '',
    createdAt: r.created_at || ''
  };
}

// ───────────────────────── bonus / free ─────────────────────────
function _bonusSign(type) {
  return (type === 'give' || type === 'point_sale') ? 1
       : (type === 'return' || type === 'point_damage_return') ? -1 : 0;
}

// ══════════════════════════════════════════════════════════════════════
//  BONUS  (CALC-3, v5.1)
// ══════════════════════════════════════════════════════════════════════
// ONE bonus model: a pure date-range calculation, no "cleared" bookkeeping.
//   net pieces sold in [from,to] = give + point_sale − return − point_damage_return
//   bonus = floor( floor(net / case_size) / cases_required ) × free units (or money)
// The rule used is the one SNAPSHOTTED on each transaction row (columns
// rule_*), so editing a product later never rewrites an old period. Rows
// written before v5.1 have no snapshot and fall back to the product's
// current rule (exactly what the old code did).
// Every screen (dashboard card, bonus report, profit) calls this one function.
async function _bonusGroups(from, to) {
  try {
    const { data, error } = await supabase.rpc('bonus_net_units', { p_from: from, p_to: to });
    if (error) throw error;
    return (data || []).map(r => ({
      productId: String(r.product_id || ''), cs: r.case_size, bcr: r.bonus_cases_req,
      free: r.bonus_free_units, money: r.bonus_free_money,
      net: num(r.net_units), outUnits: num(r.out_units), outCost: num(r.out_cost)
    }));
  } catch (e) {
    // function not installed yet → slower, identical result
    const rows = await fetchAll(() => supabase.from('transactions')
      .select('product_id,type,total_units,total_cost,rule_case_size,rule_bonus_cases_req,rule_bonus_free_units,rule_bonus_free_money')
      .in('type', ['give', 'return', 'point_sale', 'point_damage_return']).gte('date', from).lte('date', to));
    const g = {};
    rows.forEach(r => {
      const k = [r.product_id, r.rule_case_size, r.rule_bonus_cases_req, r.rule_bonus_free_units, r.rule_bonus_free_money].join('|');
      const o = g[k] || (g[k] = { productId: String(r.product_id || ''), cs: r.rule_case_size, bcr: r.rule_bonus_cases_req,
        free: r.rule_bonus_free_units, money: r.rule_bonus_free_money, net: 0, outUnits: 0, outCost: 0 });
      const sign = _bonusSign(r.type), u = num(r.total_units);
      o.net += sign * u;
      if (sign > 0) { o.outUnits += u; o.outCost += num(r.total_cost); }
    });
    return Object.values(g);
  }
}

async function computeBonusRangeSummary(from, to) {
  const [prodsRaw, groups] = await Promise.all([
    fetchAll(() => supabase.from('products').select('*').order('created_at')),
    _bonusGroups(from, to)
  ]);
  const prods = (prodsRaw || []).map(mapProduct);
  const byId = {}; prods.forEach(p => { byId[p.id] = p; });
  const acc = {};
  groups.forEach(gr => {
    const p = byId[gr.productId]; if (!p) return;
    // snapshot rule if present, else the product's current rule
    const cs   = (gr.cs   != null ? num(gr.cs)   : num(p.caseSize))      || 1;
    const bcr  = (gr.bcr  != null ? num(gr.bcr)  : num(p.bonusCasesReq)) || 1;
    const free = gr.free  != null ? num(gr.free)  : num(p.bonusFreeUnits);
    const mny  = gr.money != null ? num(gr.money) : num(p.bonusFreeMoney);
    if (free <= 0 && mny <= 0) {
      const a0 = acc[p.id] || (acc[p.id] = { totalGiven: 0, totalCases: 0, bonusUnits: 0, bonusMoney: 0, amount: 0 });
      a0.totalGiven += Math.max(0, gr.net); return;
    }
    const given = Math.max(0, gr.net);
    const cases = Math.floor(given / cs + 1e-9);
    const mult  = Math.floor(cases / bcr + 1e-9);
    const avgPP = gr.outUnits > 0 ? gr.outCost / gr.outUnits : num(p.purchasePrice);
    const a = acc[p.id] || (acc[p.id] = { totalGiven: 0, totalCases: 0, bonusUnits: 0, bonusMoney: 0, amount: 0 });
    a.totalGiven += given; a.totalCases += cases;
    a.bonusUnits += mult * free; a.bonusMoney += mult * mny;
    a.amount += mult * free * avgPP + mult * mny;
  });
  return prods.filter(p => num(p.bonusFreeUnits) > 0 || num(p.bonusFreeMoney) > 0 || (acc[p.id] && acc[p.id].amount > 0)).map(p => {
    const a = acc[p.id] || { totalGiven: 0, totalCases: 0, bonusUnits: 0, bonusMoney: 0, amount: 0 };
    return {
      productId: p.id, name: p.name, sku: p.sku, thumb: p.thumb || '',
      caseSize: num(p.caseSize) || 1, purchasePrice: num(p.purchasePrice), sellingPrice: num(p.sellingPrice),
      bonusFreeUnits: num(p.bonusFreeUnits), bonusCasesReq: num(p.bonusCasesReq) || 1, bonusFreeMoney: num(p.bonusFreeMoney || 0),
      totalGiven: a.totalGiven, totalCases: a.totalCases, bonusUnits: a.bonusUnits, bonusMoney: a.bonusMoney,
      amount: Math.round(a.amount * 100) / 100
    };
  });
}

// ───────────────────────── profit ─────────────────────────
// v5.7 — NET profit = gross profit − commission ONLY. Discount, damage, bonus and expenses are
// no longer deducted (they are still returned as separate figures for display). The rules are
// fixed here on purpose so an old saved `profit_rules` row can never switch them back on.
const DEFAULT_PROFIT_RULES = { commission: true, discount: false, damage: false, bonus: false, expenses: false };
async function getProfitRules() { return Object.assign({}, DEFAULT_PROFIT_RULES); }
async function getSalesSummary(from, to) {
  try {
    const { data, error } = await supabase.rpc('sales_summary', { p_from: from, p_to: to });
    if (error) throw error;
    const r = (data && data[0]) || {};
    return { outRev: num(r.out_rev), inRev: num(r.in_rev), outCost: num(r.out_cost), inCost: num(r.in_cost), outUnits: num(r.out_units), inUnits: num(r.in_units) };
  } catch (e) {
    const rows = await fetchAll(() => supabase.from('transactions').select('type,total_units,total_revenue,total_cost')
      .in('type', ['give', 'return', 'point_sale', 'point_damage_return']).gte('date', from).lte('date', to));
    const o = { outRev: 0, inRev: 0, outCost: 0, inCost: 0, outUnits: 0, inUnits: 0 };
    rows.forEach(r => {
      if (r.type === 'give' || r.type === 'point_sale') { o.outRev += num(r.total_revenue); o.outCost += num(r.total_cost); o.outUnits += num(r.total_units); }
      else { o.inRev += num(r.total_revenue); o.inCost += num(r.total_cost); o.inUnits += num(r.total_units); }
    });
    return o;
  }
}

async function getProfitExtras(from, to) {
  try {
    const { data, error } = await supabase.rpc('profit_extras', { p_from: from, p_to: to });
    if (error) throw error;
    const r = (data && data[0]) || {};
    return { commission: num(r.commission), discount: num(r.discount), damageLoss: num(r.damage_loss), expenses: num(r.expenses) };
  } catch (e) {
    const [pay, dmg, exp] = await Promise.all([
      fetchAll(() => supabase.from('sr_payments').select('commission_amt,discount_amt').gte('date', from).lte('date', to)),
      fetchAll(() => supabase.from('dmg_claims').select('total_cost').gte('date', from).lte('date', to)),
      fetchAll(() => supabase.from('exp_records').select('amount').gte('date', from).lte('date', to))
    ]);
    return {
      commission: pay.reduce((s, r) => s + num(r.commission_amt), 0),
      discount: pay.reduce((s, r) => s + num(r.discount_amt), 0),
      damageLoss: dmg.reduce((s, r) => s + num(r.total_cost), 0),
      expenses: exp.reduce((s, r) => s + num(r.amount), 0)
    };
  }
}

async function computeProfit(from, to) {
  const [sales, extras, bonusRows, rules] = await Promise.all([
    getSalesSummary(from, to), getProfitExtras(from, to), computeBonusRangeSummary(from, to), getProfitRules()
  ]);
  const r2_ = n => Math.round((num(n) + Number.EPSILON) * 100) / 100;
  const revenue = sales.outRev - sales.inRev;
  const cost = sales.outCost - sales.inCost;
  const grossProfit = revenue - cost;
  const bonus = bonusRows.reduce((s, b) => s + num(b.amount), 0);
  const net = grossProfit
    - (rules.commission ? extras.commission : 0)
    - (rules.discount   ? extras.discount   : 0)
    - (rules.damage     ? extras.damageLoss : 0)
    - (rules.bonus      ? bonus             : 0)
    - (rules.expenses   ? extras.expenses   : 0);
  return {
    from, to, rules,
    revenue: r2_(revenue), cost: r2_(cost), grossProfit: r2_(grossProfit),
    commission: r2_(extras.commission), discount: r2_(extras.discount), damageLoss: r2_(extras.damageLoss),
    bonus: r2_(bonus), expenses: r2_(extras.expenses),
    netProfit: r2_(net),
    givenUnits: sales.outUnits, returnUnits: sales.inUnits
  };
}

// ───────────────────────── aggregates ─────────────────────────
async function _rpcOr(name, args, fallback) {
  try {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw error;
    return data || [];
  } catch (e) { return fallback(); }
}

// ── v5.4 display helpers: exact "cases + loose pieces" totals ─────────────
// Units are summed PER PRODUCT first and then split with THAT product's own
// case size, so the answer is exact (never a bare total-piece count).
function cpSplit(unitsByProduct, csMap) {
  let cases = 0, pcs = 0;
  // v5.11 — per-unit-type breakdown. A shop can sell কেস, ডজন, কার্টুন and পলি
  // products together; "5 কেস" must not swallow the ডজন / পলি packs. The unit
  // name of each product comes from csMap.__ut (see withUnits) — when it is not
  // supplied the old cases + pcs result is returned unchanged.
  const ut = (csMap && csMap.__ut) || null, by = {};
  Object.keys(unitsByProduct || {}).forEach(k => {
    const cs = Math.max(1, Math.round(num((csMap || {})[k])) || 1);
    const u  = Math.max(0, Math.round(num(unitsByProduct[k])));
    const c = Math.floor(u / cs);
    cases += c; pcs += u % cs;
    if (ut && c > 0) { const n = ut[k] || 'কেস'; by[n] = (by[n] || 0) + c; }
  });
  const out = { cases, pcs };
  if (ut) out.by = Object.keys(by).map(n => ({ unit: n, cases: by[n] }));
  return out;
}
// attach the product → unit-name map to a case-size map (non-enumerable, so
// Object.keys / JSON of the map itself never changes)
function withUnits(csMap, products) {
  const ut = {};
  (products || []).forEach(p => { ut[String(p.id)] = String(p.unit_type || p.unitType || 'কেস'); });
  Object.defineProperty(csMap, '__ut', { value: ut, enumerable: false, configurable: true });
  return csMap;
}
// rows: [{type, productId|product_id, totalUnits|total_units}]  groups: { name: [types…] }
function cpGroups(rows, csMap, groups) {
  const acc = {}; Object.keys(groups).forEach(g => { acc[g] = {}; });
  (rows || []).forEach(r => {
    const pid = String(r.productId != null ? r.productId : (r.product_id || ''));
    const u = num(r.totalUnits != null ? r.totalUnits : r.total_units);
    Object.keys(groups).forEach(g => { if (groups[g].indexOf(r.type) >= 0) acc[g][pid] = (acc[g][pid] || 0) + u; });
  });
  const out = {}; Object.keys(groups).forEach(g => { out[g] = cpSplit(acc[g], csMap); });
  return out;
}
async function getCaseTotals(from, to, groups, srId) {
  const types = Array.from(new Set([].concat.apply([], Object.keys(groups).map(g => groups[g]))));
  const [tx, pr] = await Promise.all([
    fetchAll(() => { let q = supabase.from('transactions').select('product_id,type,total_units').in('type', types).gte('date', from).lte('date', to); if (srId) q = q.eq('sr_id', srId); return q; }),
    fetchAll(() => supabase.from('products').select('id,case_size,unit_type'))
  ]);
  const cs = {}; pr.forEach(p => { cs[String(p.id)] = num(p.case_size) || 1; }); withUnits(cs, pr);
  return cpGroups(tx, cs, groups);
}

async function getProductNetUnits(from, to) {
  const rows = await _rpcOr('product_sales_totals', { p_from: from, p_to: to }, async () => {
    const tx = await fetchAll(() => supabase.from('transactions').select('product_id,type,total_units')
      .in('type', ['give', 'return', 'point_sale', 'point_damage_return']).gte('date', from).lte('date', to));
    const m = {};
    tx.forEach(r => { const k = String(r.product_id || ''); if (!k) return; m[k] = (m[k] || 0) + _bonusSign(r.type) * num(r.total_units); });
    return Object.keys(m).map(k => ({ product_id: k, net_units: m[k] }));
  });
  const out = {};
  rows.forEach(r => { out[String(r.product_id || '')] = num(r.net_units); });
  return out;
}

// ───────────────────────── audit / idempotency / stock guard ─────────────────────────
async function auditLog(actor, action, table, rowId, oldData, newData) {
  try {
    await supabase.from('audit_log').insert({
      actor_id: String((actor && actor.id) || ''), actor_role: String((actor && actor.role) || ''),
      action, table_name: table, row_id: String(rowId || ''), old_data: oldData || null, new_data: newData || null
    });
  } catch (e) { /* table not installed yet — ignore */ }
}

// ── Idempotency (CALC-8) ──────────────────────────────────────────────
// The browser attaches a `requestId` to every money-writing POST. A double
// tap / network retry carries the SAME id, so the second call gets the
// first call's answer back instead of writing everything twice.
// Failed requests are never remembered, so a retry after an error works.
const _RID_RE = /^[A-Za-z0-9_-]{8,80}$/;
function _noTable(err) {
  const m = String((err && (err.code || '')) + ' ' + String((err && err.message) || ''));
  return /42P01|PGRST205|does not exist|schema cache/i.test(m);
}
async function idemRun(req, res, scope, fn) {
  const rid = req && req.body && typeof req.body.requestId === 'string' ? req.body.requestId.trim() : '';
  if (!_RID_RE.test(rid)) return fn();
  const key = scope + ':' + rid;
  const claim = await supabase.from('idempotency_keys').insert({ key, response: null });
  if (claim.error) {
    if (_noTable(claim.error)) return fn();
    const { data: ex } = await supabase.from('idempotency_keys').select('response,created_at').eq('key', key).maybeSingle();
    if (ex && ex.response) return res.json(Object.assign({}, ex.response, { replayed: true }));
    const age = ex ? Date.now() - new Date(ex.created_at).getTime() : 1e9;
    if (age < 60000) return res.json({ ok: false, error: 'আগের অনুরোধটি এখনও চলছে — একটু অপেক্ষা করুন, আবার চাপবেন না' });
    // an old claim from a crashed request — take it over
    await supabase.from('idempotency_keys').delete().eq('key', key);
    const again = await supabase.from('idempotency_keys').insert({ key, response: null });
    if (again.error) return res.json({ ok: false, error: 'আগের অনুরোধটি এখনও চলছে — একটু অপেক্ষা করুন' });
  }
  const origJson = res.json.bind(res), origStatus = res.status.bind(res);
  let captured, code = null;
  res.status = (c) => { code = c; return res; };
  res.json = (p) => { captured = p; return res; };
  try {
    await fn();
  } catch (e) {
    res.json = origJson; res.status = origStatus;
    try { await supabase.from('idempotency_keys').delete().eq('key', key); } catch (_) {}
    throw e;
  }
  res.json = origJson; res.status = origStatus;
  try {
    if (captured && captured.ok) await supabase.from('idempotency_keys').update({ response: captured }).eq('key', key);
    else await supabase.from('idempotency_keys').delete().eq('key', key);
    if (Math.random() < 0.02) await supabase.from('idempotency_keys').delete().lt('created_at', new Date(Date.now() - 7 * 86400000).toISOString());
  } catch (_) {}
  if (code) origStatus(code);
  return origJson(captured);
}

// Stock guard switch (app_settings.block_negative_stock, default ON).
async function blockNegativeStock() {
  try {
    const { data, error } = await supabase.from('app_settings').select('block_negative_stock').eq('id', 1).maybeSingle();
    if (error) throw error;
    return !(data && data.block_negative_stock === false);
  } catch (e) { return true; }
}
// ══════════════════════════════════════════════════════════════════════
//  LIFETIME DUE TOTALS — ONE source of truth for every panel
// ══════════════════════════════════════════════════════════════════════
// due = (Σ give revenue − Σ return revenue) − Σ payments, per DSR/SO.
// Previously each dashboard (Owner / Manager / SO / DSR) pulled the WHOLE
// transactions + sr_payments history into Node and summed it there, and
// some of those payment reads were not paginated — so the same DSR showed
// a different DU depending on which panel asked. Now every panel calls
// this. When the `dsr_due_totals` SQL function exists the
// sums are done inside Postgres in one tiny query (fast, exact, no 1000-row
// cap possible); if it isn't installed yet it falls back to the paginated
// JS path, which gives the identical numbers, just slower.
// Returns { [srId]: { givenRev, returnRev, givenUnits, returnUnits, payments } }
async function getDueTotals(srIds) {
  const ids = Array.isArray(srIds) ? srIds.map(String).filter(Boolean) : null;
  if (ids && !ids.length) return {};
  const out = {};
  const slot = (sid) => (out[sid] = out[sid] || { givenRev: 0, returnRev: 0, givenUnits: 0, returnUnits: 0, payments: 0 });
  try {
    const { data, error } = await supabase.rpc('dsr_due_totals', { p_sr_ids: ids });
    if (error) throw error;
    (data || []).forEach(r => {
      const sid = String(r.sr_id || ''); if (!sid) return;
      const o = slot(sid);
      o.givenRev = num(r.given_rev); o.returnRev = num(r.return_rev);
      o.givenUnits = num(r.given_units); o.returnUnits = num(r.return_units);
      o.payments = num(r.paid);
    });
    return out;
  } catch (e) {
    // fall through to the slower, still-correct paginated path
  }
  const [tx, pay] = await Promise.all([
    fetchAll(() => {
      let q = supabase.from('transactions').select('type,sr_id,total_units,total_revenue').in('type', ['give', 'return']);
      if (ids) q = q.in('sr_id', ids);
      return q;
    }),
    fetchAll(() => {
      let q = supabase.from('sr_payments').select('sr_id,amount');
      if (ids) q = q.in('sr_id', ids);
      return q;
    })
  ]);
  tx.forEach(r => {
    const sid = String(r.sr_id || ''); if (!sid) return;
    const o = slot(sid);
    if (r.type === 'give')   { o.givenRev += num(r.total_revenue);  o.givenUnits += num(r.total_units); }
    if (r.type === 'return') { o.returnRev += num(r.total_revenue); o.returnUnits += num(r.total_units); }
  });
  pay.forEach(r => { const sid = String(r.sr_id || ''); if (sid) slot(sid).payments += num(r.amount); });
  return out;
}

module.exports = {
  supabase, getDueTotals, cors, num, ds, today, now_, str, safeErr, fetchAll, pageParams,
  mapProduct, mapSR, mapShop, mapTx, mapDmg, mapBonus, mapPayment, mapExpCat, mapExpRecord, mapDue, mapSlip,
  computeBonusRangeSummary,
  bdtDateStr, bdtToday, addDaysStr, bdtYesterday,
  cyclePeriodBounds, cyclePeriodForDate, cyclePeriodToday, cyclePeriodDates,
  _bonusSign, getSalesSummary, getProfitExtras, getProfitRules, computeProfit, DEFAULT_PROFIT_RULES,
  getProductNetUnits, auditLog, idemRun, blockNegativeStock,
  cpSplit, cpGroups, getCaseTotals, withUnits
};

