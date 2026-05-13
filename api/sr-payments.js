const { supabase, cors, num, now_, mapPayment } = require('./_lib/db');
const { randomUUID } = require('crypto');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  try {
    // ══════════════════════════════════════════════════
    //  MANAGER APPROVAL FLOW
    // ══════════════════════════════════════════════════

    // GET pending approvals — owner sees all, manager sees own
    if (req.method === 'GET' && action === 'approvals') {
      const managerId = req.query && req.query.managerId;
      let q = supabase.from('manager_pending_approvals')
        .select('*').order('submitted_at', { ascending: false });
      if (managerId) q = q.eq('manager_id', managerId);
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ ok: true, approvals: (data || []).map(mapApproval) });
    }

    // POST — Manager submits entry for approval
    if (req.method === 'POST' && action === 'approval_submit') {
      const d = req.body;
      const { error } = await supabase.from('manager_pending_approvals').insert({
        id:           randomUUID(),
        manager_id:   d.managerId   || '',
        manager_name: d.managerName || '',
        input_type:   d.inputType   || '',
        input_data:   d.inputData   || {},
        submitted_at: now_(),
        status:       'pending',
        approved_at:  null,
        approved_by:  null
      });
      if (error) throw error;
      return res.json({ ok: true });
    }

    // POST — Owner approves a single entry
    if (req.method === 'POST' && action === 'approval_approve') {
      const { id } = req.body;
      const { data: row, error: fetchErr } = await supabase
        .from('manager_pending_approvals').select('*').eq('id', id).single();
      if (fetchErr) throw fetchErr;
      if (!row || row.status !== 'pending')
        return res.json({ ok: false, error: 'এন্ট্রি পাওয়া যায়নি বা ইতিমধ্যে প্রক্রিয়া হয়েছে' });
      await _doApprove(row);
      const { error: updErr } = await supabase.from('manager_pending_approvals')
        .update({ status: 'approved', approved_at: now_(), approved_by: 'owner' })
        .eq('id', id);
      if (updErr) throw updErr;
      return res.json({ ok: true });
    }

    // POST — Owner approves ALL pending entries at once
    if (req.method === 'POST' && action === 'approval_approve_all') {
      const { data: rows, error: fetchErr } = await supabase
        .from('manager_pending_approvals').select('*').eq('status', 'pending');
      if (fetchErr) throw fetchErr;
      if (!rows || !rows.length) return res.json({ ok: true, count: 0 });
      for (const row of rows) { await _doApprove(row); }
      const ids = rows.map(r => r.id);
      const { error: updErr } = await supabase.from('manager_pending_approvals')
        .update({ status: 'approved', approved_at: now_(), approved_by: 'owner' })
        .in('id', ids);
      if (updErr) throw updErr;
      return res.json({ ok: true, count: rows.length });
    }

    // POST — Owner rejects a single entry
    if (req.method === 'POST' && action === 'approval_reject') {
      const { id } = req.body;
      const { error } = await supabase.from('manager_pending_approvals')
        .update({ status: 'rejected', approved_at: now_(), approved_by: 'owner' })
        .eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    // ══════════════════════════════════════════════════
    //  EXISTING PAYMENT LOGIC (unchanged)
    // ══════════════════════════════════════════════════

    if (req.method === 'GET') {
      const { srId, from, to } = req.query;
      let q = supabase.from('sr_payments').select('*').order('created_at');
      if (srId) q = q.eq('sr_id', srId);
      if (from) q = q.gte('date', from);
      if (to)   q = q.lte('date', to);
      const { data, error } = await q;
      if (error) throw error;
      return res.json((data || []).map(mapPayment));
    }

    if (req.method === 'POST') {
      const d = req.body;
      const cashAmt   = num(d.cashAmount)    || 0;
      const commAmt   = num(d.commissionAmt) || 0;
      const discAmt   = num(d.discountAmt)   || 0;
      const dmgAmt    = num(d.damageAmt)     || 0;
      const total = cashAmt + commAmt + discAmt + dmgAmt || num(d.amount);
      const { error } = await supabase.from('sr_payments').insert({
        sr_id:          d.srId    || '',
        sr_name:        d.srName  || '',
        date:           d.date,
        amount:         total,
        cash_amount:    cashAmt,
        commission_amt: commAmt,
        discount_amt:   discAmt,
        damage_amt:     dmgAmt,
        note:           d.note    || '',
        created_at:     now_()
      });
      if (error) throw error;
      return res.json({ ok: true });
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
};

// ── Map approval row to frontend shape ──────────────────────────────
function mapApproval(r) {
  return {
    id:          String(r.id || ''),
    managerId:   String(r.manager_id   || ''),
    managerName: r.manager_name || '',
    inputType:   r.input_type   || '',
    inputData:   r.input_data   || {},
    submittedAt: r.submitted_at || '',
    status:      r.status       || 'pending',
    approvedAt:  r.approved_at  || '',
    approvedBy:  r.approved_by  || ''
  };
}

// ── Move one approved row into its real table(s) ───────────────────
async function _doApprove(row) {
  const d  = row.input_data || {};
  const ts = new Date().toISOString();

  if (row.input_type === 'transaction') {
    const txId = randomUUID();
    const rows = (d.items || []).map(item => {
      const u  = num(item.totalUnits);
      const pp = num(item.purchasePrice);
      const sp = num(item.sellingPrice);
      return {
        tx_id:          txId,
        type:           d.type,
        sr_id:          d.srId   || '',
        sr_name:        d.srName || '',
        date:           d.date,
        slip_no:        d.slipNo || '',
        product_id:     String(item.productId   || ''),
        product_name:   String(item.productName || ''),
        sku:            String(item.sku         || ''),
        cases:          num(item.cases),
        pcs:            num(item.pcs),
        total_units:    u,
        purchase_price: pp,
        selling_price:  sp,
        total_cost:     u * pp,
        total_revenue:  u * sp,
        note:           d.note || '',
        created_at:     ts
      };
    });
    const { error: txErr } = await supabase.from('transactions').insert(rows);
    if (txErr) throw txErr;

    if (d.type === 'damage') {
      const dmgRows = (d.items || []).map(item => {
        const u  = num(item.totalUnits);
        const pp = num(item.purchasePrice);
        return {
          tx_id:          txId,
          product_id:     String(item.productId   || ''),
          product_name:   String(item.productName || ''),
          sku:            String(item.sku         || ''),
          total_units:    u,
          purchase_price: pp,
          total_cost:     u * pp,
          date:           d.date,
          sr_id:          d.srId   || '',
          sr_name:        d.srName || '',
          status:         'pending',
          cleared_date:   null,
          created_at:     ts
        };
      });
      const { error: dmgErr } = await supabase.from('dmg_claims').insert(dmgRows);
      if (dmgErr) throw dmgErr;
    }
  }

  if (row.input_type === 'payment') {
    const cashAmt = num(d.cashAmount)    || 0;
    const commAmt = num(d.commissionAmt) || 0;
    const discAmt = num(d.discountAmt)   || 0;
    const dmgAmt  = num(d.damageAmt)     || 0;
    const total   = cashAmt + commAmt + discAmt + dmgAmt || num(d.amount);
    const { error } = await supabase.from('sr_payments').insert({
      sr_id:          d.srId   || '',
      sr_name:        d.srName || '',
      date:           d.date,
      amount:         total,
      cash_amount:    cashAmt,
      commission_amt: commAmt,
      discount_amt:   discAmt,
      damage_amt:     dmgAmt,
      note:           d.note  || '',
      created_at:     ts
    });
    if (error) throw error;
  }

  if (row.input_type === 'expense') {
    const entries = d.entries || [];
    if (entries.length) {
      const expRows = entries.map(e => ({
        category_id:   String(e.categoryId   || ''),
        category_name: String(e.categoryName || ''),
        date:          d.date,
        amount:        num(e.amount),
        note:          d.note || '',
        created_at:    ts
      }));
      const { error } = await supabase.from('exp_records').insert(expRows);
      if (error) throw error;
    }
  }
}
