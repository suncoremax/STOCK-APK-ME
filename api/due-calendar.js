const { supabase, cors, num, now_, mapDue, safeErr } = require('./_lib/db');
const { randomUUID } = require('crypto');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET — fetch dues filtered by month and/or dsrId
    if (req.method === 'GET') {
      const { month, dsrId } = req.query;
      let q = supabase.from('due_calendar').select('*').order('due_date');
      if (month) {
        const [calY, calM] = month.split('-').map(Number);
        const lastDay  = new Date(calY, calM, 0).getDate();
        const lastDate = month + '-' + String(lastDay).padStart(2, '0');
        q = q.gte('due_date', month + '-01').lte('due_date', lastDate);
      }
      // dsrId filter: DSR or SO can only see their own calendar dues
      if (dsrId) q = q.eq('dsr_id', dsrId);
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ ok: true, dues: (data || []).map(mapDue) });
    }

    // POST — add a new due entry
    if (req.method === 'POST') {
      const d = req.body;
      if (!d.dueDate || !d.amount) return res.json({ ok: false, error: 'dueDate ও amount প্রয়োজন' });
      const { data, error } = await supabase.from('due_calendar').insert({
        id:          randomUUID(),
        dsr_id:      d.dsrId   || '',
        dsr_name:    d.dsrName || '',
        client_type: d.clientType || 'dsr',
        shop_name:   d.shopName || '',
        due_date:    d.dueDate,
        amount:      num(d.amount),
        paid_amount: 0,
        note:        d.note || '',
        status:      'pending',
        cleared_date: null,
        created_at:  now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, due: mapDue(data) });
    }

    // PUT — partial/full payment, undo, or edit fields
    if (req.method === 'PUT') {
      const d = req.body;
      if (!d.id) return res.json({ ok: false, error: 'id প্রয়োজন' });

      if (typeof d.payAmount !== 'undefined') {
        const pay = num(d.payAmount);
        if (pay <= 0) return res.json({ ok: false, error: 'পরিমাণ ০-এর বেশি হতে হবে' });

        const { data: cur, error: fetchErr } = await supabase
          .from('due_calendar').select('amount,paid_amount,status').eq('id', d.id).single();
        if (fetchErr) throw fetchErr;

        const total       = num(cur.amount);
        const alreadyPaid = num(cur.paid_amount);
        const newPaid     = Math.min(alreadyPaid + pay, total);
        const remaining   = total - newPaid;
        const newStatus   = remaining <= 0 ? 'cleared' : 'partial';
        const clearedDate = newStatus === 'cleared'
          ? new Date().toISOString().slice(0, 10) : null;

        const { error: updErr } = await supabase.from('due_calendar').update({
          paid_amount:  newPaid,
          status:       newStatus,
          cleared_date: clearedDate
        }).eq('id', d.id);
        if (updErr) throw updErr;

        return res.json({ ok: true, paidAmount: newPaid, remaining, status: newStatus });
      }

      const updates = {};
      if (d.status === 'cleared') {
        updates.status       = 'cleared';
        updates.cleared_date = new Date().toISOString().slice(0, 10);
        const { data: cur } = await supabase
          .from('due_calendar').select('amount').eq('id', d.id).single();
        if (cur) updates.paid_amount = num(cur.amount);
      } else if (d.status === 'pending') {
        updates.status       = 'pending';
        updates.paid_amount  = 0;
        updates.cleared_date = null;
      }
      if (d.dueDate)            updates.due_date    = d.dueDate;
      if (d.amount)             updates.amount      = num(d.amount);
      if (d.dsrName)            updates.dsr_name    = d.dsrName;
      if (d.dsrId)              updates.dsr_id      = d.dsrId;
      if (d.clientType)         updates.client_type = d.clientType;
      if (d.shopName !== undefined) updates.shop_name = d.shopName;
      if (d.note !== undefined) updates.note        = d.note;

      const { error } = await supabase.from('due_calendar').update(updates).eq('id', d.id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    // DELETE — remove a due entry
    if (req.method === 'DELETE') {
      const d = req.body;
      if (!d.id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      const { error } = await supabase.from('due_calendar').delete().eq('id', d.id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
