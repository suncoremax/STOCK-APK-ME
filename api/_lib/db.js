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

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function ds(v)  { if (!v) return ''; return String(v).slice(0, 10); }
function today(){ return new Date().toISOString().slice(0, 10); }
function now_() { return new Date().toISOString(); }
function str(v, max = 255) { return String(v || '').trim().slice(0, max); }

// Bangladesh is UTC+6 all year (no DST) — shift the clock manually instead of
// depending on ICU timezone data being present in the serverless runtime.
function dhakaParts(d) {
  const dt = new Date((d ? d.getTime() : Date.now()) + 6 * 60 * 60 * 1000);
  return {
    dateStr: dt.toISOString().slice(0, 10),
    hh: dt.getUTCHours(),
    mm: dt.getUTCMinutes(),
    dow: dt.getUTCDay() // 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
  };
}
// Count non-Friday ("working") days between two YYYY-MM-DD strings, inclusive.
function countWorkingDays(fromStr, toStr) {
  if (!fromStr || !toStr || fromStr > toStr) return 0;
  let n = 0;
  let cur = new Date(fromStr + 'T00:00:00Z');
  const end = new Date(toStr + 'T00:00:00Z');
  while (cur <= end) {
    if (cur.getUTCDay() !== 5) n++; // 5 = Friday
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
  }
  return n;
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
    purchasePrice: String(r.purchase_price || 0),
    sellingPrice: String(r.selling_price || 0),
    bonusFreeUnits: String(r.bonus_free_units || 0),
    bonusCasesReq: String(r.bonus_cases_req || 1),
    bonusFreeMoney: String(r.bonus_free_money || 0),
    lowStockAlert: String(r.low_stock_alert || 0),
    thumb: r.thumb || '',
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

function mapAttendance(r) {
  return {
    id: String(r.id || ''),
    userKey: String(r.user_key || ''),
    userName: r.user_name || '',
    role: r.role || '',
    punchDate: r.punch_date ? String(r.punch_date).slice(0, 10) : '',
    punchTime: r.punch_time || '',
    status: r.status || 'present',
    lat: r.lat != null ? String(r.lat) : '',
    lng: r.lng != null ? String(r.lng) : '',
    createdAt: r.created_at || ''
  };
}

function mapLiveLoc(r) {
  return {
    userKey: String(r.user_key || ''),
    userName: r.user_name || '',
    role: r.role || '',
    lat: r.lat != null ? String(r.lat) : '',
    lng: r.lng != null ? String(r.lng) : '',
    updatedAt: r.updated_at || ''
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
    if (r.type === 'damage') m[pid] -= u;
    if (r.type === 'point_sale')          m[pid] -= u;
    if (r.type === 'point_damage_return') m[pid] += u;
  });
  return m;
}

async function computeBonusSummary() {
  const { data: prodsRaw } = await supabase.from('products').select('*').order('created_at');
  const { data: txRaw }    = await supabase.from('transactions').select('*').order('created_at');
  const { data: bonusRaw } = await supabase.from('bonus').select('*').order('created_at');
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

module.exports = {
  supabase, cors, num, ds, today, now_, str, safeErr,
  dhakaParts, countWorkingDays,
  mapProduct, mapSR, mapTx, mapDmg, mapBonus, mapPayment,
  mapExpCat, mapExpRecord, mapDue, mapChatMsg,
  mapAttendance, mapLiveLoc,
  calcStock, computeBonusSummary
};
