const { supabase, cors, num, now_, mapPayment, mapOrder, safeErr, fetchAll } = require('./_lib/db');
const { sendPush } = require('./_lib/push');
const { randomUUID } = require('crypto');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
      await sendPush({
        title: 'অনুমোদনের অপেক্ষায়',
        body:  (d.managerName || 'ম্যানেজার') + ' থেকে একটি নতুন এন্ট্রি অনুমোদনের জন্য এসেছে',
        url:   '/approvals',
        role:  'owner'
      });
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
      if (row.manager_id) {
        await sendPush({
          title: 'এন্ট্রি অনুমোদিত হয়েছে',
          body:  'আপনার জমা দেওয়া এন্ট্রি Owner অনুমোদন করেছেন',
          url:   '/approvals',
          userKey: row.manager_id
        });
      }
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
      const byManager = {};
      rows.forEach(r => { if (r.manager_id) byManager[r.manager_id] = (byManager[r.manager_id] || 0) + 1; });
      await Promise.all(Object.keys(byManager).map(mgrId => sendPush({
        title: 'এন্ট্রি অনুমোদিত হয়েছে',
        body:  byManager[mgrId] + 'টি জমা দেওয়া এন্ট্রি Owner অনুমোদন করেছেন',
        url:   '/approvals',
        userKey: mgrId
      })));
      return res.json({ ok: true, count: rows.length });
    }

    // POST — Owner rejects a single entry
    if (req.method === 'POST' && action === 'approval_reject') {
      const { id } = req.body;
      const { data: rejRow } = await supabase
        .from('manager_pending_approvals').select('manager_id').eq('id', id).maybeSingle();
      const { error } = await supabase.from('manager_pending_approvals')
        .update({ status: 'rejected', approved_at: now_(), approved_by: 'owner' })
        .eq('id', id);
      if (error) throw error;
      if (rejRow && rejRow.manager_id) {
        await sendPush({
          title: 'এন্ট্রি বাতিল হয়েছে',
          body:  'আপনার জমা দেওয়া এন্ট্রি Owner বাতিল করেছেন',
          url:   '/approvals',
          userKey: rejRow.manager_id
        });
      }
      return res.json({ ok: true });
    }

    // POST — Owner edits a pending entry's data before approving.
    // Requires Owner PIN re-entry every time (AXIION §9 "no miss edit").
    if (req.method === 'POST' && action === 'approval_edit') {
      const { id, ownerPin, updatedInputData } = req.body || {};
      if (!id || !ownerPin || !updatedInputData)
        return res.json({ ok: false, error: 'id, ownerPin ও updatedInputData প্রয়োজন' });

      const { data: ownerRow, error: pinErr } = await supabase
        .from('user_passwords').select('id').eq('role', 'owner').eq('password', String(ownerPin).trim()).limit(1);
      if (pinErr) throw pinErr;
      if (!ownerRow || !ownerRow.length) return res.json({ ok: false, error: 'ভুল Owner PIN' });

      const { data: row, error: fetchErr } = await supabase
        .from('manager_pending_approvals').select('status').eq('id', id).single();
      if (fetchErr) throw fetchErr;
      if (!row || row.status !== 'pending')
        return res.json({ ok: false, error: 'এন্ট্রি পাওয়া যায়নি বা ইতিমধ্যে প্রক্রিয়া হয়েছে' });

      const { error } = await supabase.from('manager_pending_approvals')
        .update({ input_data: updatedInputData }).eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    // ══════════════════════════════════════════════════
    //  SO ORDERING → APPROVAL → VAN-LOAD WORKFLOW (AXIION §13)
    // ══════════════════════════════════════════════════

    // POST — SO places a new order
    if (req.method === 'POST' && action === 'order_submit') {
      const d = req.body || {};
      const items = Array.isArray(d.items) ? d.items : [];
      if (!d.soId || !items.length) return res.json({ ok: false, error: 'soId ও items প্রয়োজন' });
      const requestedAmount = items.reduce((s, it) => s + num(it.totalUnits) * num(it.sellingPrice), 0);

      // AXIION §17-follow-up: auto-carry the SO's currently connected DSR
      // (so_link_status='accepted', set via the §10/§17 pairing handshake)
      // onto the order at the moment it's placed, so Manager/Owner no
      // longer have to hand-pick a DSR at approval time — they just
      // approve and it's already routed to the paired DSR. If the SO
      // hasn't connected with any DSR yet, this stays blank and the
      // approver falls back to picking one manually (see order_approve).
      let autoDsrId = '';
      const { data: pairedDsr } = await supabase.from('srs')
        .select('id').eq('so_id', String(d.soId)).eq('so_link_status', 'accepted').limit(1);
      if (pairedDsr && pairedDsr.length) autoDsrId = String(pairedDsr[0].id);

      const { data, error } = await supabase.from('orders').insert({
        id: randomUUID(), so_id: String(d.soId), so_name: d.soName || '',
        items, requested_amount: requestedAmount,
        status: 'pending', assigned_dsr_id: autoDsrId, load_status: 'not_started', load_ticks: {},
        created_at: now_()
      }).select().single();
      if (error) throw error;
      const orderPushBody = (d.soName || 'একজন SO') + ' থেকে নতুন অর্ডার এসেছে';
      await Promise.all([
        sendPush({ title: 'নতুন অর্ডার', body: orderPushBody, url: '/orders', role: 'owner' }),
        sendPush({ title: 'নতুন অর্ডার', body: orderPushBody, url: '/orders', role: 'manager' })
      ]);
      return res.json({ ok: true, order: mapOrder(data) });
    }

    // POST — Modify an order.
    //  requestedBy = 'manager'|'owner': applies directly, no extra approval.
    //  requestedBy = 'dsr': stored as a proposal, needs order_approve.
    if (req.method === 'POST' && action === 'order_modify') {
      const d = req.body || {};
      if (!d.id || !Array.isArray(d.items)) return res.json({ ok: false, error: 'id ও items প্রয়োজন' });
      const modifiedAmount = d.items.reduce((s, it) => s + num(it.totalUnits) * num(it.sellingPrice), 0);

      if (d.requestedBy === 'manager' || d.requestedBy === 'owner') {
        const { error } = await supabase.from('orders').update({
          items: d.items, modified_by: d.requestedBy, modified_amount: modifiedAmount,
          proposed_items: null
        }).eq('id', d.id);
        if (error) throw error;
        return res.json({ ok: true, appliedDirectly: true });
      }

      // DSR-requested change — held as a proposal until Manager/Owner approves
      const { error } = await supabase.from('orders').update({
        status: 'modified_pending', proposed_items: d.items, modified_amount: modifiedAmount, modified_by: 'dsr'
      }).eq('id', d.id);
      if (error) throw error;
      await Promise.all([
        sendPush({ title: 'অর্ডার পরিবর্তনের অনুরোধ', body: 'একটি DSR অর্ডারে পরিবর্তনের প্রস্তাব দিয়েছে', url: '/orders', role: 'owner' }),
        sendPush({ title: 'অর্ডার পরিবর্তনের অনুরোধ', body: 'একটি DSR অর্ডারে পরিবর্তনের প্রস্তাব দিয়েছে', url: '/orders', role: 'manager' })
      ]);
      return res.json({ ok: true, appliedDirectly: false });
    }

    // POST — Manager/Owner finalises an order (accepts any DSR proposal
    // too) and assigns it as a Load Task to a DSR.
    // dsrId is now OPTIONAL — if the SO was connected to a DSR when the
    // order was placed (order_submit auto-fills assigned_dsr_id from that
    // pairing), Manager/Owner just approve as-is. dsrId is only needed
    // as a manual override/fallback when no pairing existed at submit time.
    if (req.method === 'POST' && action === 'order_approve') {
      const { id, dsrId, approvedBy } = req.body || {};
      if (!id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      const { data: row, error: fetchErr } = await supabase.from('orders').select('*').eq('id', id).single();
      if (fetchErr) throw fetchErr;
      if (!row || !['pending', 'modified_pending'].includes(row.status))
        return res.json({ ok: false, error: 'অর্ডার পাওয়া যায়নি বা ইতিমধ্যে প্রক্রিয়া হয়েছে' });

      const finalDsrId = String(dsrId || row.assigned_dsr_id || '');
      if (!finalDsrId)
        return res.json({ ok: false, error: 'এই SO কোনো DSR এর সাথে সংযুক্ত নয় — অনুমোদনের আগে ম্যানুয়ালি একজন DSR নির্বাচন করুন' });

      const finalItems = row.status === 'modified_pending' && row.proposed_items ? row.proposed_items : row.items;
      const { error } = await supabase.from('orders').update({
        items: finalItems, proposed_items: null,
        status: 'approved', assigned_dsr_id: finalDsrId, load_status: 'not_started', load_ticks: {},
        approved_by: approvedBy || '', approved_at: now_()
      }).eq('id', id);
      if (error) throw error;
      if (row.so_id) {
        await sendPush({ title: 'অর্ডার অনুমোদিত', body: 'আপনার অর্ডারটি অনুমোদিত হয়েছে', url: '/orders', userKey: row.so_id });
      }
      return res.json({ ok: true, dsrId: finalDsrId });
    }

    // POST — Manager/Owner rejects a pending SO order outright
    if (req.method === 'POST' && action === 'order_reject') {
      const { id } = req.body || {};
      if (!id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      const { data: row, error: fetchErr } = await supabase.from('orders').select('status,so_id').eq('id', id).single();
      if (fetchErr) throw fetchErr;
      if (!row || !['pending', 'modified_pending'].includes(row.status))
        return res.json({ ok: false, error: 'অর্ডার পাওয়া যায়নি বা ইতিমধ্যে প্রক্রিয়া হয়েছে' });
      const { error } = await supabase.from('orders').update({ status: 'rejected' }).eq('id', id);
      if (error) throw error;
      if (row.so_id) {
        await sendPush({ title: 'অর্ডার বাতিল হয়েছে', body: 'আপনার অর্ডারটি বাতিল করা হয়েছে', url: '/orders', userKey: row.so_id });
      }
      return res.json({ ok: true });
    }

    // POST — Owner/Manager gives stock directly to a DSR. Instead of an
    // instant stock write, this creates an already-approved Load Task
    // exactly like an approved SO order — the DSR must physically tick
    // each item and press "Finish Loading" before stock actually leaves
    // the warehouse. (Owner's give needs no further approval; a
    // Manager's give still goes through the existing approval_submit →
    // Owner-approval queue first — see _doApprove below, which now
    // routes an approved Manager "give" through this same path instead
    // of writing straight to transactions.)
    if (req.method === 'POST' && action === 'give_direct') {
      const d = req.body || {};
      const items = Array.isArray(d.items) ? d.items : [];
      if (!d.dsrId || !items.length) return res.json({ ok: false, error: 'dsrId ও items প্রয়োজন' });
      const requestedAmount = items.reduce((s, it) => s + num(it.totalUnits) * num(it.sellingPrice), 0);
      const who = d.requestedBy === 'manager' ? 'ম্যানেজার' : 'মালিক';
      const label = 'দেওয়া (' + who + (d.requestedByName ? ' — ' + d.requestedByName : '') + ')';
      const { data, error } = await supabase.from('orders').insert({
        id: randomUUID(), so_id: '', so_name: label,
        items, requested_amount: requestedAmount,
        status: 'approved', assigned_dsr_id: String(d.dsrId), load_status: 'not_started', load_ticks: {},
        approved_by: d.requestedBy || 'owner', approved_at: now_(), created_at: now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, order: mapOrder(data) });
    }

    // GET — order queue for Manager/Owner (all) or a specific SO (own only)
    if (req.method === 'GET' && action === 'orders_list') {
      const { soId, status } = req.query;
      let q = supabase.from('orders').select('*').order('created_at', { ascending: false });
      if (soId) q = q.eq('so_id', soId);
      if (status) q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ ok: true, orders: (data || []).map(mapOrder) });
    }

    // GET — DSR's pending load checklist
    if (req.method === 'GET' && action === 'van_load_list') {
      const { dsrId } = req.query;
      if (!dsrId) return res.json({ ok: false, error: 'dsrId প্রয়োজন' });
      const { data, error } = await supabase.from('orders')
        .select('*').eq('assigned_dsr_id', dsrId).eq('status', 'approved')
        .in('load_status', ['not_started', 'loading']).order('approved_at');
      if (error) throw error;
      return res.json({ ok: true, orders: (data || []).map(mapOrder) });
    }

    // POST — DSR ticks one product line as physically loaded
    if (req.method === 'POST' && action === 'van_load_tick') {
      const { id, itemId, ticked } = req.body || {};
      if (!id || !itemId) return res.json({ ok: false, error: 'id ও itemId প্রয়োজন' });
      const { data: row, error: fetchErr } = await supabase.from('orders').select('load_ticks').eq('id', id).single();
      if (fetchErr) throw fetchErr;
      const ticks = { ...(row.load_ticks || {}), [itemId]: ticked !== false };
      const { error } = await supabase.from('orders')
        .update({ load_ticks: ticks, load_status: 'loading' }).eq('id', id);
      if (error) throw error;
      return res.json({ ok: true, loadTicks: ticks });
    }

    // POST — DSR finishes loading → writes the real `give` transactions
    if (req.method === 'POST' && action === 'van_load_finish') {
      const { id } = req.body || {};
      if (!id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      const { data: row, error: fetchErr } = await supabase.from('orders').select('*').eq('id', id).single();
      if (fetchErr) throw fetchErr;
      if (!row || row.status !== 'approved') return res.json({ ok: false, error: 'অর্ডার পাওয়া যায়নি' });

      const items = row.items || [];
      const ticks = row.load_ticks || {};
      const allTicked = items.every(it => ticks[it.id || it.productId] === true);
      if (!allTicked) return res.json({ ok: false, error: 'সব পণ্য টিক দেওয়া হয়নি' });

      const txId = randomUUID();
      const date = new Date().toISOString().slice(0, 10);
      const rows = items.map(item => {
        const u = num(item.totalUnits), sp = num(item.sellingPrice), pp = num(item.purchasePrice);
        return {
          tx_id: txId, type: 'give', sr_id: row.assigned_dsr_id, sr_name: '',
          date, slip_no: '', product_id: String(item.productId || ''), product_name: String(item.productName || ''),
          sku: String(item.sku || ''), cases: num(item.cases), pcs: num(item.pcs),
          total_units: u, purchase_price: pp, selling_price: sp,
          total_cost: u * pp, total_revenue: u * sp,
          note: 'ভ্যান-লোড অর্ডার #' + String(row.id).slice(0, 8), created_at: now_()
        };
      });
      const { error: txErr } = await supabase.from('transactions').insert(rows);
      if (txErr) throw txErr;

      const { error } = await supabase.from('orders').update({ load_status: 'loaded' }).eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    // ══════════════════════════════════════════════════
    //  DSR RECONCILE (V31) — "how much can we actually collect from him
    //  today, and how much stays as due" — used by the SR পেমেন্ট (Payment)
    //  entry screen. lifetimeDue mirrors the exact give/return/payments
    //  formula used everywhere else in the app (dashboard.js ownDue) so
    //  it always agrees with the DSR's own dashboard figure. The `today`
    //  block additionally breaks out how much of today's given stock he
    //  has actually sold to shops (dsr_sale — doesn't touch stock/due by
    //  itself), how much cash he already collected from those shop sales
    //  (should be handed over now), how much became a fresh shop-credit
    //  due today (visible, but still under his name until collected), and
    //  how much given stock is still unaccounted for (still on the van /
    //  not yet sold, returned, or damaged).
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'dsr-reconcile') {
      const { dsrId, date } = req.query;
      if (!dsrId) return res.json({ ok: false, error: 'dsrId প্রয়োজন' });
      const d = (date && DATE_RE.test(date)) ? date : new Date().toISOString().slice(0, 10);

      // Lifetime due — identical formula to the DSR's own dashboard due.
      // Paginated: a long-running DSR's lifetime give/return history can
      // pass the 1000-row PostgREST cap after a couple of years.
      const allDueTx = await fetchAll(() => supabase.from('transactions')
        .select('type,total_revenue').eq('sr_id', dsrId).in('type', ['give', 'return']));
      const givenRevAll  = (allDueTx || []).filter(r => r.type === 'give').reduce((s, r) => s + num(r.total_revenue), 0);
      const returnRevAll = (allDueTx || []).filter(r => r.type === 'return').reduce((s, r) => s + num(r.total_revenue), 0);
      const allPay = await fetchAll(() => supabase.from('sr_payments').select('amount').eq('sr_id', dsrId));
      const paidAll = (allPay || []).reduce((s, r) => s + num(r.amount), 0);
      const lifetimeDue = (givenRevAll - returnRevAll) - paidAll;

      // Today's movement — given / returned / damage / sold-to-shops.
      // V35 — damage here uses total_revenue (SELLING price), not
      // total_cost (buying price): this is the DSR Payment page, where
      // damage represents value the DSR is no longer expected to collect
      // from customers (a selling-price figure), NOT the separate
      // buying-price reimbursement claim shown on the Damage Report
      // (dmg_claims / api/claims.js) — those two stay intentionally
      // different. commission_amt/discount_amt (V35 columns, populated
      // on 'dsr_sale' rows) give the DSR Payment page real "today's
      // commission" / "today's discount" totals instead of leaving them
      // for the manager to guess and type manually.
      const { data: dayTx, error: dayTxErr } = await supabase.from('transactions')
        .select('type,total_revenue,total_cost,commission_amt,discount_amt').eq('sr_id', dsrId).eq('date', d)
        .in('type', ['give', 'return', 'damage', 'dsr_sale']);
      if (dayTxErr) throw dayTxErr;
      const sum = (t, f) => (dayTx || []).filter(r => r.type === t).reduce((s, r) => s + num(r[f]), 0);
      const givenToday       = sum('give', 'total_revenue');
      const returnedToday    = sum('return', 'total_revenue');
      const damageToday      = sum('damage', 'total_revenue');
      const soldToShopsToday = sum('dsr_sale', 'total_revenue');
      const commissionToday  = sum('dsr_sale', 'commission_amt');
      const discountToday    = sum('dsr_sale', 'discount_amt');

      // Cash actually collected today vs. fresh shop-credit created today.
      const { data: dueToday, error: dueTodayErr } = await supabase.from('due_calendar')
        .select('amount,paid_amount').eq('dsr_id', dsrId).eq('client_type', 'shop').eq('due_date', d);
      if (dueTodayErr) throw dueTodayErr;
      const cashCollectedToday  = (dueToday || []).reduce((s, r) => s + num(r.paid_amount), 0);
      const shopDueCreatedToday = (dueToday || []).reduce((s, r) => s + (num(r.amount) - num(r.paid_amount)), 0);
      const stillWithDsrToday   = givenToday - returnedToday - damageToday - soldToShopsToday;

      return res.json({
        ok: true, dsrId: String(dsrId), date: d,
        lifetimeDue,
        today: {
          givenToday, returnedToday, damageToday, soldToShopsToday,
          commissionToday, discountToday,
          cashCollectedToday, shopDueCreatedToday, stillWithDsrToday
        }
      });
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
    res.json({ ok: false, error: safeErr(e) });
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
    // "give" now flows through the van-load safety net (same as SO
    // orders and Owner's give_direct) instead of writing stock out the
    // moment Owner approves it — the DSR still has to tick every item
    // and press "Finish Loading" before the real transaction rows (and
    // the stock deduction) actually get written.
    if (d.type === 'give') {
      const items = d.items || [];
      const requestedAmount = items.reduce((s, item) => s + num(item.totalUnits) * num(item.sellingPrice), 0);
      const label = 'দেওয়া (ম্যানেজার' + (d.srName ? ' → ' + d.srName : '') + ')';
      const { error: ordErr } = await supabase.from('orders').insert({
        id: randomUUID(), so_id: '', so_name: label,
        items, requested_amount: requestedAmount,
        status: 'approved', assigned_dsr_id: String(d.srId || ''), load_status: 'not_started', load_ticks: {},
        approved_by: 'owner', approved_at: ts, created_at: ts
      });
      if (ordErr) throw ordErr;
      return;
    }

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
