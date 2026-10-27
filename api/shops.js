// Shops (register, direct sale, goods back, manual due, collection, ledger).
//   GET    (none)                    shop list with open due
//   POST   {action:'add'|...}        see below
const crypto = require('crypto');
const { supabase, cors, str, safeErr, num, ds, today, fetchAll, mapShop, mapDue, mapTx, auditLog, idemRun, blockNegativeStock } = require('./_lib/db');
const { requireAuth, needPin } = require('./_lib/auth');
const { priceItems, txRow, stockShortage, reverseStock, r2 } = require('./_lib/money');
const OWNER = { id: 'owner', role: 'owner' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const money = (v) => Math.max(0, r2(num(v)));

async function openDue(shopId) {
  const { data } = await supabase.from('due_calendar').select('amount,paid_amount').eq('shop_id', shopId).neq('status', 'cleared');
  return r2((data || []).reduce((s, r) => s + Math.max(0, num(r.amount) - num(r.paid_amount)), 0));
}
async function shopOf(id) {
  if (!id) return null;
  const { data } = await supabase.from('shops').select('*').eq('id', String(id)).maybeSingle();
  return data;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const q = req.query || {};
  try {
    if (req.method === 'GET') {
      const action = q.action || 'list';
      if (action === 'list') {
        const [shops, dues] = await Promise.all([
          fetchAll(() => supabase.from('shops').select('*').order('created_at', { ascending: false })),
          supabase.rpc('shop_due_totals', { p_shop_ids: null })
        ]);
        const dm = {}; ((dues && dues.data) || []).forEach(r => { dm[String(r.shop_id)] = r2(num(r.due)); });
        const list = shops.map(mapShop); list.forEach(s => { s.due = dm[s.id] || 0; });
        // walk-in / named customers with a due but no registered shop
        const { data: cust } = await supabase.from('due_calendar').select('shop_name,amount,paid_amount').eq('shop_id', '').neq('status', 'cleared');
        const cm = {};
        (cust || []).forEach(r => { const k = r.shop_name || 'গ্রাহক'; cm[k] = r2((cm[k] || 0) + Math.max(0, num(r.amount) - num(r.paid_amount))); });
        return res.json({ ok: true, shops: list, customers: Object.keys(cm).map(k => ({ name: k, due: cm[k] })).filter(c => c.due > 0) });
      }
      if (action === 'dues') {   // every open due row (the due calendar)
        const rows = await fetchAll(() => supabase.from('due_calendar').select('*').neq('status', 'cleared').order('due_date'));
        return res.json({ ok: true, dues: rows.map(mapDue) });
      }
      if (action === 'ledger') {
        const shop = await shopOf(q.shopId);
        if (!shop) return res.json({ ok: false, error: 'দোকান পাওয়া যায়নি' });
        const sid = String(shop.id);
        const [dues, cols, tx] = await Promise.all([
          fetchAll(() => supabase.from('due_calendar').select('*').eq('shop_id', sid).order('created_at')),
          fetchAll(() => supabase.from('due_collections').select('*').eq('shop_id', sid).order('created_at')),
          fetchAll(() => supabase.from('transactions').select('*').eq('shop_id', sid).in('type', ['point_sale', 'point_damage_return']).order('created_at'))
        ]);
        const byTx = {}; tx.forEach(r => { (byTx[String(r.tx_id)] = byTx[String(r.tx_id)] || []).push(mapTx(r)); });
        const entries = [];
        dues.forEach(d => {
          const items = d.tx_id ? (byTx[String(d.tx_id)] || []) : [];
          entries.push({ kind: d.tx_id ? 'sale' : 'due', id: d.id, txId: d.tx_id || '', at: d.created_at, date: ds(d.entry_date || d.created_at),
            total: num(d.amount), paid: num(d.initial_paid), add: r2(num(d.amount) - num(d.initial_paid)), note: d.note || '', items,
            commission: items.reduce((s, i) => s + num(i.commissionAmt), 0), discount: items.reduce((s, i) => s + num(i.discountAmt), 0) });
        });
        cols.forEach(c => entries.push({ kind: c.kind === 'return' ? 'return' : 'collect', id: c.id, at: c.created_at, date: ds(c.date), paid: num(c.amount), add: -num(c.amount), note: c.note || '' }));
        entries.sort((a, b) => String(a.at).localeCompare(String(b.at)));
        let run = 0; entries.forEach(e => { run = r2(run + e.add); e.balance = run; });
        return res.json({ ok: true, shop: mapShop(shop), entries, due: run });
      }
      return res.json({ ok: false, error: 'Unknown action' });
    }

    if (req.method === 'POST') return idemRun(req, res, 'shop', async () => {
      const d = req.body || {};
      const action = d.action;

      if (action === 'add') {
        const name = str(d.name, 100);
        if (!name) return res.json({ ok: false, error: 'দোকানের নাম দিন' });
        const phone = str(d.phone, 30);
        if (phone) {
          const { data: dup } = await supabase.from('shops').select('name').eq('phone', phone).limit(1);
          if (dup && dup.length) return res.json({ ok: false, error: 'এই নম্বরে "' + dup[0].name + '" আগেই আছে' });
        }
        let dsrName = '';
        if (d.assignedDsrId) { const { data: sr } = await supabase.from('srs').select('name').eq('id', String(d.assignedDsrId)).maybeSingle(); dsrName = (sr && sr.name) || ''; }
        const { data: no, error: e1 } = await supabase.rpc('next_shop_no'); if (e1) throw e1;
        const { data, error } = await supabase.from('shops').insert({ shop_no: 'SHOP-' + String(no).padStart(4, '0'), name, keeper_name: str(d.keeperName, 80), phone,
          address: str(d.address, 200), assigned_dsr_id: dsrName ? String(d.assignedDsrId) : '', assigned_dsr_name: dsrName }).select().single();
        if (error) throw error;
        await auditLog(OWNER, 'create', 'shops', data.id, null, data);
        return res.json({ ok: true, shop: mapShop(data) });
      }

      if (action === 'edit') {
        const patch = {};
        if (d.name !== undefined) { patch.name = str(d.name, 100); if (!patch.name) return res.json({ ok: false, error: 'দোকানের নাম দিন' }); }
        if (d.keeperName !== undefined) patch.keeper_name = str(d.keeperName, 80);
        if (d.phone !== undefined) patch.phone = str(d.phone, 30);
        if (d.address !== undefined) patch.address = str(d.address, 200);
        if (d.assignedDsrId !== undefined) {
          let n = ''; if (d.assignedDsrId) { const { data: sr } = await supabase.from('srs').select('name').eq('id', String(d.assignedDsrId)).maybeSingle(); n = (sr && sr.name) || ''; }
          patch.assigned_dsr_id = n ? String(d.assignedDsrId) : ''; patch.assigned_dsr_name = n;
        }
        const { data, error } = await supabase.from('shops').update(patch).eq('id', String(d.id || '')).select().single();
        if (error) throw error;
        if (patch.name) { await supabase.from('due_calendar').update({ shop_name: patch.name }).eq('shop_id', data.id); await supabase.from('due_collections').update({ shop_name: patch.name }).eq('shop_id', data.id); }
        return res.json({ ok: true, shop: mapShop(data) });
      }

      const date = DATE_RE.test(d.date || '') ? d.date : today();

      // direct sale (point_sale) or goods handed back (point_damage_return)
      if (action === 'sale' || action === 'return') {
        const shop = await shopOf(d.shopId);
        const custName = str(d.customerName, 80);
        if (!shop && !custName) return res.json({ ok: false, error: 'দোকান বেছে নিন বা গ্রাহকের নাম লিখুন' });
        if (action === 'return' && !shop) return res.json({ ok: false, error: 'ফেরতের জন্য নিবন্ধিত দোকান বেছে নিন' });
        const type = action === 'sale' ? 'point_sale' : 'point_damage_return';
        const pr = await priceItems(d.items, { type, date });
        if (!pr.ok) return res.json({ ok: false, error: pr.error });
        if (type === 'point_sale') {
          const short = stockShortage(pr.lines);
          if (short && await blockNegativeStock()) return res.json({ ok: false, error: short });
        }
        const txId = crypto.randomUUID(), now = new Date().toISOString();
        const gross = r2(pr.lines.reduce((s, l) => s + l.revenue, 0));
        const base = { tx_id: txId, type, sr_id: '', sr_name: '', date, slip_no: str(d.slipNo, 40), shop_id: shop ? String(shop.id) : '', customer_id: shop ? '' : custName,
          note: str(d.note, 300), created_at: now };
        const rows = pr.lines.map(l => txRow(l, base));
        if (type === 'point_sale') {
          const comm = money(d.commission), disc = money(d.discount);
          if (comm + disc > gross + 0.001) return res.json({ ok: false, error: 'কমিশন + ছাড় মোট বিলের চেয়ে বেশি' });
          rows[0].commission_amt = comm; rows[0].discount_amt = disc;
          const payable = r2(gross - comm - disc), paid = Math.min(money(d.paid), payable);
          const due = { id: crypto.randomUUID(), tx_id: txId, dsr_id: shop ? String(shop.assigned_dsr_id || '') : '', dsr_name: shop ? shop.assigned_dsr_name || '' : '',
            client_type: shop ? 'shop' : 'custom', shop_id: shop ? String(shop.id) : '', shop_name: shop ? shop.name : custName, due_date: DATE_RE.test(d.dueDate || '') ? d.dueDate : date,
            entry_date: date, amount: payable, paid_amount: paid, note: str(d.note, 300),
            status: payable - paid <= 0.004 ? 'cleared' : (paid > 0 ? 'partial' : 'pending'), cleared_date: payable - paid <= 0.004 ? date : null, created_at: now };
          const { error } = await supabase.rpc('create_shop_sale', { p_rows: rows, p_due: due });
          if (error) throw error;
          await auditLog(OWNER, 'create', 'transactions', txId, null, { type, shop: due.shop_name, gross, payable, paid });
          return res.json({ ok: true, txId, date, gross, commission: comm, discount: disc, payable, paid, due: r2(payable - paid), shopName: due.shop_name,
            rows: rows.map(r => mapTx(Object.assign({ id: '' }, r))) });
        }
        const credit = await openDue(String(shop.id));
        const { data: applied, error } = await supabase.rpc('create_shop_return', { p_rows: rows, p_shop_id: String(shop.id), p_credit: Math.min(gross, credit), p_date: date, p_note: 'পণ্য ফেরত' });
        if (error) throw error;
        await auditLog(OWNER, 'create', 'transactions', txId, null, { type, shop: shop.name, gross });
        return res.json({ ok: true, txId, date, gross, appliedToDue: r2(num(applied)), cashBack: r2(gross - num(applied)), shopName: shop.name,
          rows: rows.map(r => mapTx(Object.assign({ id: '' }, r))) });
      }

      // a manual due (an old balance, or a sale made on paper)
      if (action === 'due-add') {
        const shop = await shopOf(d.shopId);
        const custName = str(d.customerName, 80);
        const amount = money(d.amount);
        if (!shop && !custName) return res.json({ ok: false, error: 'দোকান বেছে নিন বা নাম লিখুন' });
        if (amount <= 0) return res.json({ ok: false, error: 'টাকার পরিমাণ দিন' });
        const { data, error } = await supabase.from('due_calendar').insert({ dsr_id: shop ? String(shop.assigned_dsr_id || '') : '', dsr_name: shop ? shop.assigned_dsr_name || '' : '',
          client_type: shop ? 'shop' : 'custom', shop_id: shop ? String(shop.id) : '', shop_name: shop ? shop.name : custName, due_date: DATE_RE.test(d.dueDate || '') ? d.dueDate : date,
          entry_date: date, amount, paid_amount: 0, initial_paid: 0, note: str(d.note, 300) || 'হাতে লেখা বাকি', status: 'pending', tx_id: '' }).select().single();
        if (error) throw error;
        await auditLog(OWNER, 'create', 'due_calendar', data.id, null, data);
        return res.json({ ok: true, due: mapDue(data) });
      }

      // money collected from a shop (applied to the oldest due first)
      if (action === 'collect') {
        const amount = money(d.amount);
        if (amount <= 0) return res.json({ ok: false, error: 'টাকার পরিমাণ দিন' });
        let dueSum;
        if (d.shopId) dueSum = await openDue(String(d.shopId));
        else {   // a named customer without a registered shop
          const { data: rows } = await supabase.from('due_calendar').select('id,amount,paid_amount').eq('shop_id', '').eq('shop_name', str(d.customerName, 80)).neq('status', 'cleared').order('created_at');
          dueSum = r2((rows || []).reduce((s, r) => s + Math.max(0, num(r.amount) - num(r.paid_amount)), 0));
          if (amount <= dueSum + 0.01) {
            let left = amount;
            for (const r of rows || []) {
              if (left <= 0.004) break;
              const take = Math.min(left, r2(num(r.amount) - num(r.paid_amount))), np = r2(num(r.paid_amount) + take), cl = num(r.amount) - np <= 0.004;
              await supabase.from('due_calendar').update({ paid_amount: np, status: cl ? 'cleared' : 'partial', cleared_date: cl ? date : null }).eq('id', r.id);
              await supabase.from('due_collections').insert({ due_id: String(r.id), shop_id: '', shop_name: str(d.customerName, 80), date, amount: take, kind: 'cash', note: str(d.note, 300) });
              left -= take;
            }
            return res.json({ ok: true, applied: amount, dueAfter: r2(dueSum - amount) });
          }
        }
        if (amount > dueSum + 0.01) return res.json({ ok: false, error: 'বাকি আছে মাত্র ৳' + dueSum });
        const { data, error } = await supabase.rpc('shop_apply_payment', { p_shop_id: String(d.shopId), p_amount: amount, p_date: date, p_kind: 'cash', p_note: str(d.note, 300) });
        if (error) throw error;
        await auditLog(OWNER, 'create', 'due_collections', String(d.shopId), null, { amount, date });
        return res.json({ ok: true, applied: r2(num(data)), dueAfter: r2(dueSum - num(data)) });
      }
      return res.json({ ok: false, error: 'Unknown action' });
    });

    if (req.method === 'DELETE') {
      if (!(await needPin(req, res, q.pin))) return;
      const action = q.action || 'shop';
      if (action === 'shop') {
        const id = String(q.id || '');
        const [a, b] = await Promise.all([
          supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('shop_id', id),
          supabase.from('due_calendar').select('id', { count: 'exact', head: true }).eq('shop_id', id)
        ]);
        if ((a.count || 0) + (b.count || 0) > 0) return res.json({ ok: false, error: 'এই দোকানের লেনদেন/বাকির হিসাব আছে — মুছে ফেলা যাবে না' });
        const { error } = await supabase.from('shops').delete().eq('id', id); if (error) throw error;
        return res.json({ ok: true });
      }
      if (action === 'sale') {   // undo a direct sale: only while nothing has been collected against it
        const txId = String(q.txId || '');
        const { data: rows } = await supabase.from('transactions').select('*').eq('tx_id', txId);
        if (!rows || !rows.length) return res.json({ ok: false, error: 'বিক্রয় পাওয়া যায়নি' });
        const { data: due } = await supabase.from('due_calendar').select('*').eq('tx_id', txId).maybeSingle();
        if (due) {
          const { count } = await supabase.from('due_collections').select('id', { count: 'exact', head: true }).eq('due_id', String(due.id));
          if ((count || 0) > 0) return res.json({ ok: false, error: 'এই বিক্রয়ের বাকি থেকে টাকা আদায় হয়ে গেছে — মুছতে হলে আগে আদায়ের হিসাব ঠিক করুন' });
        }
        const err = await reverseStock(rows, await blockNegativeStock());
        if (err) return res.json({ ok: false, error: err });
        if (due) await supabase.from('due_calendar').delete().eq('id', due.id);
        await supabase.from('transactions').delete().eq('tx_id', txId);
        await auditLog(OWNER, 'delete', 'transactions', txId, { type: rows[0].type }, null);
        return res.json({ ok: true });
      }
      if (action === 'due') {    // delete a manual (hand-written) due that has had no collection
        const id = String(q.id || '');
        const { data: due } = await supabase.from('due_calendar').select('tx_id,paid_amount').eq('id', id).maybeSingle();
        if (!due) return res.json({ ok: false, error: 'পাওয়া যায়নি' });
        if (due.tx_id) return res.json({ ok: false, error: 'এটি বিক্রয়ের বাকি — বিক্রয় মুছুন' });
        if (num(due.paid_amount) > 0) return res.json({ ok: false, error: 'এর থেকে টাকা আদায় হয়েছে — মোছা যাবে না' });
        await supabase.from('due_calendar').delete().eq('id', id);
        return res.json({ ok: true });
      }
      return res.json({ ok: false, error: 'Unknown action' });
    }
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) { res.json({ ok: false, error: safeErr(e) }); }
};
