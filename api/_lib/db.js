const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Pagination-safe full-table fetch ──────────────────────────────────
// PostgREST (Supabase's REST layer) silently caps any query at 1000 rows
// by default — no error, it just returns the first page. Anything that
// needs an ALL-TIME aggregate (stock calc, lifetime due, bonus totals)
// MUST use this instead of a bare `await supabase.from(...).select(...)`,
// or numbers will quietly go wrong once a table passes 1000 rows.
// `queryFactory` must be a FUNCTION that returns a fresh query builder
// each call (so `.range()` can be re-applied per page) — not an
// already-built/awaited query object.
const FETCH_ALL_PAGE_SIZE = 1000;
async function fetchAll(queryFactory) {
  let from = 0;
  let all = [];
  while (true) {
    const { data, error } = await queryFactory().range(from, from + FETCH_ALL_PAGE_SIZE - 1);
    if (error) throw error;
    const rows = data || [];
    all = all.concat(rows);
    if (rows.length < FETCH_ALL_PAGE_SIZE) break;
    from += FETCH_ALL_PAGE_SIZE;
  }
  return all;
}

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function ds(v)  { if (!v) return ''; return String(v).slice(0, 10); }
function today(){ return new Date().toISOString().slice(0, 10); }
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
  if (msg.includes('duplicate') || msg.includes('unique')) return 'এই তথ্য ইতিমধ্যে আছে';
  if (msg.includes('foreign key') || msg.includes('violates')) return 'সম্পর্কিত তথ্য পাওয়া যায়নি';
  if (msg.includes('not found') || msg.includes('PGRST116')) return 'তথ্য পাওয়া যায়নি';
  return 'সার্ভার সমস্যা হয়েছে, আবার চেষ্টা করুন';
}

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
    id: String(r.id || ''),
    name: r.name || '',
    phone: r.phone || '',
    area: r.area || '',
    role: r.role || 'dsr',
    thumb: r.thumb || '',
    soId: String(r.so_id || ''),
    soName: r.so_name || '',
    // displayNo: AXIION §10 — stable per-role numbering, assigned once,
    // never reused, independent of who currently holds the slot.
    // Update #20: matching displayNo across roles (DSR-1 ↔ SO-1, …) is
    // the auto-pair — so_id/soName are set automatically at creation,
    // no manual "connect" handshake exists anymore.
    displayNo: r.display_no != null ? Number(r.display_no) : null,
    // roadId/roadName (Update #22): which Road this SO/DSR belongs to —
    // set automatically via api/srs.js action=road-assign-so, never by
    // manual per-person selection.
    roadId: String(r.road_id || ''),
    roadName: r.road_name || '',
    createdAt: r.created_at || ''
  };
}

function mapShop(r) {
  return {
    id: String(r.id || ''),
    shopNo: r.shop_no || '',
    name: r.name || '',
    keeperName: r.keeper_name || '',
    phone: r.phone || '',
    address: r.address || '',
    lat: r.lat != null ? Number(r.lat) : null,
    lng: r.lng != null ? Number(r.lng) : null,
    assignedDsrId: String(r.assigned_dsr_id || ''),
    assignedDsrName: r.assigned_dsr_name || '',
    roadId: String(r.road_id || ''),
    roadName: r.road_name || '',
    createdAt: r.created_at || ''
  };
}

// Update #51 — Point-of-Sale customer capture. A proper stored record
// (name/phone/address/keeper name — same basic fields as normal shop
// registration) instead of just a free-text customer name.
function mapPosCustomer(r) {
  return {
    id: String(r.id || ''),
    name: r.name || '',
    keeperName: r.keeper_name || '',
    phone: r.phone || '',
    address: r.address || '',
    createdAt: r.created_at || ''
  };
}

// ── Roads feature (Updates #21–27) ──────────────────────────────────
function mapRoad(r) {
  return {
    id: String(r.id || ''),
    name: r.name || '',
    soId: String(r.so_id || ''),
    soName: r.so_name || '',
    dsrId: String(r.dsr_id || ''),
    dsrName: r.dsr_name || '',
    createdAt: r.created_at || ''
  };
}

function mapRoadPlan(r) {
  return {
    id: String(r.id || ''),
    roadId: String(r.road_id || ''),
    roadName: r.road_name || '',
    soId: String(r.so_id || ''),
    soName: r.so_name || '',
    dsrId: String(r.dsr_id || ''),
    dsrName: r.dsr_name || '',
    soVisitDate: r.so_visit_date || '',
    dsrVisitDate: r.dsr_visit_date || '',
    createdBy: r.created_by || '',
    createdAt: r.created_at || ''
  };
}

function mapShopVisit(r) {
  return {
    id: String(r.id || ''),
    shopId: String(r.shop_id || ''),
    visitRole: r.visit_role || '',
    visitorId: String(r.visitor_id || ''),
    visitorName: r.visitor_name || '',
    visitDate: r.visit_date || '',
    createdAt: r.created_at || ''
  };
}

function mapOrder(r) {
  return {
    id: String(r.id || ''),
    soId: String(r.so_id || ''),
    soName: r.so_name || '',
    items: r.items || [],
    requestedAmount: String(r.requested_amount || 0),
    status: r.status || 'pending',
    modifiedBy: r.modified_by || '',
    modifiedAmount: r.modified_amount != null ? String(r.modified_amount) : '',
    proposedItems: r.proposed_items || null,
    assignedDsrId: String(r.assigned_dsr_id || ''),
    loadStatus: r.load_status || 'not_started',
    loadTicks: r.load_ticks || {},
    approvedBy: r.approved_by || '',
    approvedAt: r.approved_at || '',
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
    id: String(r.id || ''),
    dsrId: String(r.dsr_id || ''),
    dsrName: r.dsr_name || '',
    clientType: r.client_type || 'dsr',
    shopId: String(r.shop_id || ''),
    shopName: r.shop_name || '',
    dueDate: r.due_date ? String(r.due_date).slice(0,10) : '',
    amount: String(r.amount || 0),
    paidAmount: String(r.paid_amount || 0),
    note: r.note || '',
    status: r.status || 'pending',
    clearedDate: r.cleared_date ? String(r.cleared_date).slice(0,10) : '',
    createdAt: r.created_at || ''
  };
}

function mapChatMsg(r) {
  return {
    id:         String(r.id || ''),
    senderId:   String(r.sender_id || ''),
    senderName: r.sender_name || '',
    senderRole: r.sender_role || '',
    message:    r.message || '',
    createdAt:  r.created_at || ''
  };
}

function calcStock(allTx) {
  const m = {};
  allTx.forEach(r => {
    const pid = r.productId; if (!pid) return;
    if (!m[pid]) m[pid] = 0;
    const u = num(r.totalUnits);
    if (r.type === 'buy')    m[pid] += u;
    if (r.type === 'give')   m[pid] -= u;
    if (r.type === 'return') m[pid] += u;
    // V35 — 'damage' deliberately does NOT touch stock. Damage is only a
    // reporting/reimbursement record (see dmg_claims + DSR payment page);
    // the physical product was already removed from warehouse stock at
    // 'give' time (or was never in warehouse stock if damaged before
    // being given out), so subtracting it again here would incorrectly
    // double-count the loss.
    if (r.type === 'point_sale')          m[pid] -= u;
    if (r.type === 'point_damage_return') m[pid] += u;
    // 'dsr_sale' (V31) is a DSR selling stock he ALREADY took via 'give' —
    // that stock left the warehouse and was deducted already at give-time,
    // so a dsr_sale row deliberately does NOT touch stock again here.
  });
  return m;
}

async function computeBonusSummary() {
  const [prodsRaw, txRaw, bonusRaw] = await Promise.all([
    fetchAll(() => supabase.from('products').select('*').order('created_at')),
    fetchAll(() => supabase.from('transactions').select('tx_id,type,product_id,total_units,date').order('created_at')),
    fetchAll(() => supabase.from('bonus').select('*').order('created_at'))
  ]);
  const prods     = (prodsRaw || []).map(mapProduct);
  const allTx     = (txRaw    || []).map(mapTx);
  const bonusRecs = (bonusRaw || []).map(mapBonus);
  return prods.filter(p => num(p.bonusFreeUnits) > 0 || num(p.bonusFreeMoney) > 0).map(p => {
    const cleared = bonusRecs
      .filter(b => String(b.productId) === String(p.id) && b.status === 'cleared' && b.clearedDate)
      .sort((a, b) => String(b.clearedDate).localeCompare(String(a.clearedDate)));
    const lastCleared = cleared.length > 0 ? String(cleared[0].clearedDate) : '';
    const fromDate    = lastCleared || '2000-01-01';
    const txSince     = allTx.filter(r => String(r.productId) === String(p.id) && r.type === 'give' && ds(r.date) > fromDate);
    const totalGiven  = txSince.reduce((s, r) => s + num(r.totalUnits), 0);
    const cs  = num(p.caseSize) || 1;
    const bcr = num(p.bonusCasesReq) || 1;
    const totalCases = Math.floor(totalGiven / cs);
    const accUnits   = Math.floor(totalCases / bcr) * num(p.bonusFreeUnits);
    const accMoney   = Math.floor(totalCases / bcr) * num(p.bonusFreeMoney || 0);
    const accAmount  = accUnits * num(p.purchasePrice) + accMoney;
    const totalRec   = bonusRecs.filter(b => String(b.productId)===String(p.id) && b.status==='cleared').reduce((s,b)=>s+num(b.bonusAmount),0);
    return {
      productId: p.id, name: p.name, sku: p.sku, thumb: p.thumb || '',
      caseSize: cs, purchasePrice: num(p.purchasePrice), sellingPrice: num(p.sellingPrice),
      bonusFreeUnits: num(p.bonusFreeUnits), bonusCasesReq: bcr,
      bonusFreeMoney: num(p.bonusFreeMoney || 0),
      fromDate, lastCleared, totalGiven, totalCases,
      accUnits, accMoney, accAmount, totalReceived: totalRec
    };
  });
}

// V44 updates #13/#14: pure date-range bonus summary — computes bonus
// earned strictly from 'give' transactions dated inside [from,to]
// (inclusive), using the same case/bonus-cases-required formula as
// computeBonusSummary above, but with NO dependency on the `bonus`
// table's "cleared" bookkeeping. This backs the new Bonus Report screen,
// which replaced the old "পেয়েছি" (mark-paid, resets-to-zero) button
// with a plain date/range picker — pick any window (e.g. the current
// pay cycle, per update #7) and see what was earned in it; nothing here
// is ever written or reset, so the figure just naturally reflects
// whichever period the owner is looking at.
async function computeBonusRangeSummary(from, to) {
  const [prodsRaw, txRaw] = await Promise.all([
    fetchAll(() => supabase.from('products').select('*').order('created_at')),
    fetchAll(() => supabase.from('transactions')
      .select('product_id,total_units').eq('type', 'give').gte('date', from).lte('date', to))
  ]);
  const prods = (prodsRaw || []).map(mapProduct);
  const givenMap = {};
  (txRaw || []).forEach(r => {
    const pid = String(r.product_id || ''); if (!pid) return;
    givenMap[pid] = (givenMap[pid] || 0) + num(r.total_units);
  });
  return prods.filter(p => num(p.bonusFreeUnits) > 0 || num(p.bonusFreeMoney) > 0).map(p => {
    const totalGiven = givenMap[p.id] || 0;
    const cs  = num(p.caseSize) || 1;
    const bcr = num(p.bonusCasesReq) || 1;
    const totalCases  = Math.floor(totalGiven / cs);
    const bonusUnits  = Math.floor(totalCases / bcr) * num(p.bonusFreeUnits);
    const bonusMoney  = Math.floor(totalCases / bcr) * num(p.bonusFreeMoney || 0);
    const amount      = bonusUnits * num(p.purchasePrice) + bonusMoney;
    return {
      productId: p.id, name: p.name, sku: p.sku, thumb: p.thumb || '',
      caseSize: cs, purchasePrice: num(p.purchasePrice), sellingPrice: num(p.sellingPrice),
      bonusFreeUnits: num(p.bonusFreeUnits), bonusCasesReq: bcr, bonusFreeMoney: num(p.bonusFreeMoney || 0),
      totalGiven, totalCases, bonusUnits, bonusMoney, amount
    };
  });
}

module.exports = {
  supabase, cors, num, ds, today, now_, str, safeErr, fetchAll,
  mapProduct, mapSR, mapTx, mapDmg, mapBonus, mapPayment,
  mapExpCat, mapExpRecord, mapDue, mapChatMsg, mapShop, mapOrder,
  mapRoad, mapRoadPlan, mapShopVisit, mapPosCustomer,
  calcStock, computeBonusSummary, computeBonusRangeSummary,
  bdtDateStr, bdtToday, addDaysStr, bdtYesterday,
  cyclePeriodBounds, cyclePeriodForDate, cyclePeriodToday, cyclePeriodDates
};
