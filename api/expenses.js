const { supabase, cors, num, ds, now_, today, mapExpCat, mapExpRecord, mapDue, mapChatMsg, safeErr } = require('./_lib/db');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = req.query?.action || req.body?.action || '';
  try {
    // ── Expense Categories ─────────────────────────
    if (req.method === 'GET' && action === 'cats') {
      const { data, error } = await supabase.from('exp_cats').select('*').order('created_at');
      if (error) throw error;
      return res.json({ ok: true, categories: (data||[]).map(mapExpCat) });
    }
    if (req.method === 'POST' && action === 'cat') {
      const name = String(req.body?.name||'').trim();
      if (!name) return res.json({ ok: false, error: 'নাম প্রয়োজন' });
      const { error } = await supabase.from('exp_cats').insert({ name, created_at: now_() });
      if (error) throw error;
      return res.json({ ok: true });
    }
    if (req.method === 'DELETE' && action === 'cat') {
      const id = req.body?.id || req.query?.id;
      const { error } = await supabase.from('exp_cats').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }
    if (req.method === 'POST' && action === 'record') {
      const d = req.body;
      const { error } = await supabase.from('exp_records').insert({
        category_id: String(d.categoryId||''), category_name: String(d.categoryName||''),
        date: d.date, amount: num(d.amount), note: d.note||'', created_at: now_()
      });
      if (error) throw error;
      return res.json({ ok: true });
    }
    if (req.method === 'GET' && action === 'report') {
      const { from, to } = req.query;
      if (!from || !to) return res.json({ ok: false, error: 'from/to প্রয়োজন' });
      const [catRes, recRes] = await Promise.all([
        supabase.from('exp_cats').select('*').order('created_at'),
        supabase.from('exp_records').select('*').gte('date',from).lte('date',to).order('date')
      ]);
      const cats = (catRes.data||[]).map(mapExpCat);
      const rows = (recRes.data||[]).map(mapExpRecord);
      const catMap = {};
      cats.forEach(c => { catMap[c.id] = { id: c.id, name: c.name, total: 0 }; });
      rows.forEach(r => {
        if (!catMap[r.categoryId]) catMap[r.categoryId] = { id:r.categoryId, name:r.categoryName, total:0 };
        catMap[r.categoryId].total += num(r.amount);
      });
      const dayMap = {};
      rows.forEach(r => {
        const d = ds(r.date);
        if (!dayMap[d]) dayMap[d] = { date:d, total:0, items:[] };
        dayMap[d].total += num(r.amount);
        dayMap[d].items.push({ cat:r.categoryName, amount:num(r.amount), note:r.note });
      });
      return res.json({
        ok:true, from, to,
        grandTotal: rows.reduce((s,r)=>s+num(r.amount),0),
        byCategory: Object.values(catMap).filter(c=>c.total>0).sort((a,b)=>b.total-a.total),
        byDate: Object.values(dayMap).sort((a,b)=>b.date.localeCompare(a.date))
      });
    }

    // ── Due Calendar ───────────────────────────────
    if (req.method === 'GET' && action === 'dues') {
      const { month } = req.query;
      let q = supabase.from('due_calendar').select('*').order('due_date');
      if (month) q = q.gte('due_date', month+'-01').lte('due_date', month+'-31');
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ ok: true, dues: (data||[]).map(mapDue) });
    }
    if (req.method === 'POST' && action === 'due') {
      const d = req.body;
      const { error } = await supabase.from('due_calendar').insert({
        dsr_id: d.dsrId||'', dsr_name: d.dsrName||'',
        due_date: d.dueDate, amount: num(d.amount),
        note: d.note||'', status: 'pending', created_at: now_()
      });
      if (error) throw error;
      return res.json({ ok: true });
    }
    if (req.method === 'POST' && action === 'due-clear') {
      const id = req.body?.id;
      const { error } = await supabase.from('due_calendar')
        .update({ status: 'cleared', cleared_date: today() }).eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    // ── Payment Breakdown Report (with damage_amt) ──
    if (req.method === 'GET' && action === 'pay-report') {
      const { from, to } = req.query;
      let q = supabase.from('sr_payments').select('*').order('date');
      if (from) q = q.gte('date', from);
      if (to)   q = q.lte('date', to);
      const { data, error } = await q;
      if (error) throw error;
      const rows = data || [];
      const totalCash = rows.reduce((s,r)=>s+num(r.cash_amount),0);
      const totalComm = rows.reduce((s,r)=>s+num(r.commission_amt),0);
      const totalDisc = rows.reduce((s,r)=>s+num(r.discount_amt),0);
      const totalDmg  = rows.reduce((s,r)=>s+num(r.damage_amt),0);
      const totalAmt  = rows.reduce((s,r)=>s+num(r.amount),0);
      return res.json({ ok:true, from, to,
        totalCash, totalComm, totalDisc, totalDmg, totalAmt,
        rows: rows.map(r=>({
          id: String(r.id), srId: String(r.sr_id), srName: r.sr_name,
          date: String(r.date||'').slice(0,10), amount: num(r.amount),
          cashAmount: num(r.cash_amount), commissionAmt: num(r.commission_amt),
          discountAmt: num(r.discount_amt), damageAmt: num(r.damage_amt), note: r.note
        }))
      });
    }


    // ── Group Chat ─────────────────────────────────
    if (req.method === 'GET' && action === 'chat-config') {
      return res.json({
        ok: true,
        supabaseUrl:     process.env.SUPABASE_URL     || '',
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
      });
    }
    if (req.method === 'GET' && action === 'chat-msgs') {
      const { data, error } = await supabase
        .from('group_chat_messages')
        .select('*')
        .order('created_at', { ascending: true })
        .limit(80);
      if (error) throw error;
      return res.json({ ok: true, messages: (data || []).map(mapChatMsg) });
    }
    if (req.method === 'POST' && action === 'chat-send') {
      const b = req.body || {};
      const msg = String(b.message || '').trim();
      if (!msg) return res.json({ ok: false, error: 'বার্তা প্রয়োজন' });
      const { error } = await supabase.from('group_chat_messages').insert({
        sender_id:   String(b.senderId   || ''),
        sender_name: String(b.senderName || 'অজানা'),
        sender_role: String(b.senderRole || ''),
        message:     msg,
        created_at:  now_()
      });
      if (error) throw error;
      return res.json({ ok: true });
    }

    // ── Notices ────────────────────────────────────────
    if (req.method === 'GET' && action === 'notice-get') {
      const { data, error } = await supabase.from('notices').select('*').eq('is_active', true).limit(1);
      if (error) throw error;
      const row = data && data[0];
      return res.json({ ok: true, notice: row ? { id: String(row.id), content: row.content } : null });
    }
    if (req.method === 'POST' && action === 'notice-publish') {
      const content = String(req.body?.content || '').trim();
      if (!content) return res.json({ ok: false, error: 'নোটিশ টেক্সট প্রয়োজন' });
      await supabase.from('notices').update({ is_active: false, updated_at: now_() }).eq('is_active', true);
      const { error } = await supabase.from('notices').insert({ content, is_active: true, created_at: now_(), updated_at: now_() });
      if (error) throw error;
      return res.json({ ok: true });
    }
    if (req.method === 'POST' && action === 'notice-pause') {
      const { error } = await supabase.from('notices').update({ is_active: false, updated_at: now_() }).eq('is_active', true);
      if (error) throw error;
      return res.json({ ok: true });
    }
    if (req.method === 'POST' && action === 'notice-clear') {
      const all = await supabase.from('notices').select('id');
      if (all.data && all.data.length) {
        const ids = all.data.map(r => r.id);
        const { error } = await supabase.from('notices').delete().in('id', ids);
        if (error) throw error;
      }
      return res.json({ ok: true });
    }

    // ── Important Contacts ──────────────────────────────
    if (req.method === 'GET' && action === 'contacts-list') {
      const { data, error } = await supabase.from('important_contacts').select('*').order('created_at');
      if (error) throw error;
      return res.json({ ok: true, contacts: (data||[]).map(r => ({
        id: String(r.id), name: r.name||'', role: r.role||'',
        phone: r.phone_number||'', note: r.special_note||'',
        createdBy: r.created_by||''
      }))});
    }
    if (req.method === 'POST' && action === 'contacts-add') {
      const b = req.body||{};
      const name = String(b.name||'').trim();
      if (!name) return res.json({ ok: false, error: 'নাম প্রয়োজন' });
      const { error } = await supabase.from('important_contacts').insert({
        name,
        role:         String(b.role ||'').trim(),
        phone_number: String(b.phone||'').trim(),
        special_note: String(b.note ||'').trim(),
        created_by:   String(b.createdBy||''),
        created_at:   now_()
      });
      if (error) throw error;
      return res.json({ ok: true });
    }
    if (req.method === 'POST' && action === 'contacts-edit') {
      const b = req.body||{};
      const id = b.id;
      if (!id) return res.json({ ok: false, error: 'ID প্রয়োজন' });
      const { error } = await supabase.from('important_contacts').update({
        name:         String(b.name ||'').trim(),
        role:         String(b.role ||'').trim(),
        phone_number: String(b.phone||'').trim(),
        special_note: String(b.note ||'').trim()
      }).eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }
    if (req.method === 'DELETE' && action === 'contacts-del') {
      const id = req.body?.id || req.query?.id;
      if (!id) return res.json({ ok: false, error: 'ID প্রয়োজন' });
      const { error } = await supabase.from('important_contacts').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    // ── Personal (Off-Books) Calculator — AXIION §21 ────
    //  Isolated per-user ledger; never touches company totals.
    if (req.method === 'GET' && action === 'calc-get') {
      const userKey = req.query?.userKey;
      if (!userKey) return res.json({ ok: false, error: 'userKey প্রয়োজন' });
      const { data, error } = await supabase.from('personal_ledger')
        .select('*').eq('user_key', userKey).order('date', { ascending: false });
      if (error) throw error;
      const rows = (data || []).map(r => ({
        id: String(r.id), userKey: r.user_key, type: r.type,
        amount: num(r.amount), note: r.note || '', date: ds(r.date), createdAt: r.created_at
      }));
      const received = rows.filter(r => r.type === 'received').reduce((s, r) => s + r.amount, 0);
      const given    = rows.filter(r => r.type === 'given').reduce((s, r) => s + r.amount, 0);
      return res.json({ ok: true, entries: rows, received, given, balance: received - given });
    }
    if (req.method === 'POST' && action === 'calc-add') {
      const d = req.body || {};
      if (!d.userKey) return res.json({ ok: false, error: 'userKey প্রয়োজন' });
      if (d.type !== 'received' && d.type !== 'given') return res.json({ ok: false, error: 'ভুল type' });
      const { error } = await supabase.from('personal_ledger').insert({
        user_key: String(d.userKey), type: d.type,
        amount: num(d.amount), note: d.note || '', date: d.date || today(), created_at: now_()
      });
      if (error) throw error;
      return res.json({ ok: true });
    }
    if (req.method === 'DELETE' && action === 'calc-delete') {
      const id = req.body?.id || req.query?.id;
      const userKey = req.body?.userKey || req.query?.userKey;
      if (!id || !userKey) return res.json({ ok: false, error: 'id ও userKey প্রয়োজন' });
      // A user may only delete their own entries — personal ledgers are isolated.
      const { error } = await supabase.from('personal_ledger').delete().eq('id', id).eq('user_key', userKey);
      if (error) throw error;
      return res.json({ ok: true });
    }

    // ── SO Daily "Pay to Company" Quota — AXIION §17 ────
    if (req.method === 'GET' && action === 'quota-get') {
      const { soId, date } = req.query;
      if (!soId) return res.json({ ok: false, error: 'soId প্রয়োজন' });
      const d = date || today();
      const { data, error } = await supabase.from('so_daily_quota')
        .select('*').eq('so_id', soId).eq('date', d).limit(1);
      if (error) throw error;
      const row = data && data[0];
      return res.json({ ok: true, quota: row ? num(row.amount) : null, date: d });
    }
    if (req.method === 'POST' && action === 'quota-set') {
      const d = req.body || {};
      if (!d.soId || !d.date) return res.json({ ok: false, error: 'soId ও date প্রয়োজন' });
      const { error } = await supabase.from('so_daily_quota').upsert({
        so_id: String(d.soId), date: d.date, amount: num(d.amount),
        set_by: String(d.setBy || ''), set_at: now_()
      }, { onConflict: 'so_id,date' });
      if (error) throw error;
      return res.json({ ok: true });
    }

    res.status(400).json({ ok: false, error: 'অজানা action: ' + action });
  } catch (e) { res.json({ ok: false, error: safeErr(e) }); }
};
