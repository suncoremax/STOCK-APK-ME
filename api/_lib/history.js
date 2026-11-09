// api/_lib/history.js — AXIION DMS v11: price / rule change history + legacy freeze helpers.
// Works WITHOUT any migration: history goes to the optional table product_price_history when it exists,
// otherwise into audit_log (action 'price_change'); if neither table exists the change is simply not logged (never blocks a save).
const { supabase, num, fetchAll, _noTable } = require('./db');

// product column -> { key: the snapshot field name, label: Bengali label }
const TRACKED = {
  selling_price:       { key: 'sellPrice',        label: 'বিক্রি দাম (পিস)' },
  purchase_price:      { key: 'buyPrice',         label: 'কেনা দাম (পিস)' },
  case_price:          { key: 'casePrice',        label: 'বিক্রি দাম (কেস)' },
  case_purchase_price: { key: 'casePurchasePrice', label: 'কেনা দাম (কেস)' },
  case_size:           { key: 'unitsPerCase',     label: 'কেসে পিস' },
  bonus_cases_req:     { key: 'offerCasesReq',    label: 'অফার: প্রতি কত কেস' },
  bonus_free_units:    { key: 'offerFreeUnits',   label: 'অফার: ফ্রি পিস' },
  bonus_free_money:    { key: 'offerFreeMoney',   label: 'অফার: ফ্রি টাকা' },
  // commission / discount are typed per bill, the product has no such field; if one is ever added to products, list it here.
  commission:          { key: 'commission',       label: 'কমিশন' },
  discount:            { key: 'discount',         label: 'ছাড়' }
};
const eq = (a, b) => Math.abs(num(a) - num(b)) < 1e-9;

// compare the product row BEFORE and AFTER an edit and log every tracked field that changed. Never throws.
async function recordChanges(productId, productName, oldRow, newRow, by) {
  try {
    const at = new Date().toISOString(), entries = [];
    Object.keys(TRACKED).forEach(col => {
      if (!oldRow || !(col in oldRow) || !(col in newRow)) return;
      if (eq(oldRow[col], newRow[col])) return;
      entries.push({ product_id: String(productId), product_name: productName || '', field: TRACKED[col].key, old_value: num(oldRow[col]), new_value: num(newRow[col]), changed_at: at, changed_by: by || 'owner' });
    });
    if (!entries.length) return 0;
    const ins = await supabase.from('product_price_history').insert(entries);
    if (ins.error) {
      if (!_noTable(ins.error)) return 0;
      // no history table → keep the entries in the audit log (exists in the base schema)
      await supabase.from('audit_log').insert({ actor_id: String(by || 'owner'), actor_role: 'owner', action: 'price_change', table_name: 'products', row_id: String(productId), old_data: null, new_data: { entries } });
    }
    return entries.length;
  } catch (e) { return 0; }
}

// every logged change (oldest first). productId optional.
async function loadHistory(productId) {
  const out = [];
  try {
    const rows = await fetchAll(() => { let q = supabase.from('product_price_history').select('*').order('changed_at'); if (productId) q = q.eq('product_id', String(productId)); return q; }, { tiebreak: 'changed_at' });
    (rows || []).forEach(r => out.push({ productId: String(r.product_id), productName: r.product_name || '', field: r.field, oldValue: num(r.old_value), newValue: num(r.new_value), at: r.changed_at, by: r.changed_by || '' }));
  } catch (e) { /* table not installed */ }
  try {
    let q = supabase.from('audit_log').select('at,actor_id,new_data,row_id').eq('action', 'price_change').order('at').limit(5000);
    if (productId) q = q.eq('row_id', String(productId));
    const { data } = await q;
    (data || []).forEach(r => ((r.new_data && r.new_data.entries) || []).forEach(e => out.push({ productId: String(e.product_id), productName: e.product_name || '', field: e.field, oldValue: num(e.old_value), newValue: num(e.new_value), at: e.changed_at || r.at, by: e.changed_by || r.actor_id || '' })));
  } catch (e) { /* no audit table */ }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// the value a product field had at a moment: the 'old' value of the first change made AFTER that moment, else the current value.
function valueAt(hist, productId, field, whenIso, currentValue) {
  const next = (hist || []).find(h => h.productId === String(productId) && h.field === field && String(h.at) > String(whenIso));
  return next ? next.oldValue : currentValue;
}

module.exports = { TRACKED, recordChanges, loadHistory, valueAt };
