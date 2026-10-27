// Stock movements typed by the owner: কেনা (buy) · দেওয়া (give) · ফেরত (return) · কোম্পানিতে ফেরত (return_company) · ড্যামেজ (damage)
// (Direct shop sales live in shops.js; the full day-end slip lives in payments.js.)
const crypto = require('crypto');
const { supabase, cors, str, safeErr, num, ds, today, fetchAll, mapTx, auditLog, idemRun, blockNegativeStock } = require('./_lib/db');
const { requireAuth, needPin } = require('./_lib/auth');
const { priceItems, txRow, stockShortage, reverseStock, r2 } = require('./_lib/money');
const OWNER = { id: 'owner', role: 'owner' };
const TYPES = ['buy', 'give', 'return', 'return_company', 'damage'];
const NEEDS_SR = { give: 1, return: 1, damage: 1 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  try {
    // ── list (filters: from,to,type,srId,limit) ──
    if (req.method === 'GET') {
      const q = req.query || {};
      const from = DATE_RE.test(q.from || '') ? q.from : null, to = DATE_RE.test(q.to || '') ? q.to : null;
      const limit = Math.min(Number(q.limit) || 1500, 5000);
      let query = supabase.from('transactions').select('*').order('created_at', { ascending: false }).limit(limit);
      if (from) query = query.gte('date', from);
      if (to) query = query.lte('date', to);
      if (q.type) query = query.in('type', String(q.type).split(','));
      if (q.srId) query = query.eq('sr_id', String(q.srId));
      if (q.shopId) query = query.eq('shop_id', String(q.shopId));
      const { data, error } = await query;
      if (error) throw error;
      return res.json({ ok: true, transactions: (data || []).map(mapTx) });
    }

    if (req.method === 'POST') return idemRun(req, res, 'tx', async () => {
      const d = req.body || {};
      const type = String(d.type || '');
      if (!TYPES.includes(type)) return res.json({ ok: false, error: 'ভুল ধরন' });
      // DSR / SO damage must go through the settlement (দিনশেষ হিসাব) so his due is reduced and the claim is created together.
      if (type === 'damage') return res.json({ ok: false, error: 'DSR / SO-র ড্যামেজ আলাদা লেখা যাবে না — "মাল দেওয়া ও দিনশেষ হিসাব → দিনশেষ হিসাব" থেকে লিখুন, তাহলেই তার বাকি ও কোম্পানির দাবি একসাথে ঠিক হবে' });
      const date = DATE_RE.test(d.date || '') ? d.date : today();
      let srId = '', srName = '';
      if (NEEDS_SR[type]) {
        if (!d.srId) return res.json({ ok: false, error: 'DSR / SO বেছে নিন' });
        const { data: sr } = await supabase.from('srs').select('id,name').eq('id', String(d.srId)).maybeSingle();
        if (!sr) return res.json({ ok: false, error: 'DSR / SO পাওয়া যায়নি' });
        srId = String(sr.id); srName = sr.name;
      }
      const pr = await priceItems(d.items, { type, srId, date });
      if (!pr.ok) return res.json({ ok: false, error: pr.error });
      if (type === 'give' || type === 'return_company') {
        const short = stockShortage(pr.lines);
        if (short && await blockNegativeStock()) return res.json({ ok: false, error: short });
      }
      const txId = crypto.randomUUID();
      const base = { tx_id: txId, type, sr_id: srId, sr_name: srName, date, slip_no: str(d.slipNo, 40), note: str(d.note, 300) };
      const rows = pr.lines.map(l => txRow(l, base));
      const { error } = await supabase.from('transactions').insert(rows);
      if (error) throw error;
      if (type === 'damage') {
        const claims = pr.lines.map(l => ({ tx_id: txId, product_id: l.productId, product_name: l.productName, sku: l.sku, total_units: l.units,
          purchase_price: l.purchasePrice, total_cost: l.cost, date, sr_id: srId, sr_name: srName, status: 'pending' }));
        const { error: ce } = await supabase.from('dmg_claims').insert(claims);
        if (ce) { await supabase.from('transactions').delete().eq('tx_id', txId); throw ce; }
      }
      await auditLog(OWNER, 'create', 'transactions', txId, null, { type, date, srName, lines: rows.length });
      const total = r2(pr.lines.reduce((s, l) => s + l.revenue, 0));
      res.json({ ok: true, txId, date, type, srName, total, rows: rows.map(r => mapTx(Object.assign({ id: '', created_at: new Date().toISOString() }, r))) });
    });

    // ── undo a wrongly typed entry (owner PIN) — gives the stock back ──
    if (req.method === 'DELETE') {
      const txId = String(req.query.txId || '');
      if (!(await needPin(req, res, req.query.pin))) return;
      const { data: rows, error } = await supabase.from('transactions').select('*').eq('tx_id', txId);
      if (error) throw error;
      if (!rows || !rows.length) return res.json({ ok: false, error: 'লেনদেন পাওয়া যায়নি' });
      const type = rows[0].type;
      if (!TYPES.includes(type)) return res.json({ ok: false, error: 'এটি এখান থেকে মোছা যাবে না (দোকান বিক্রয় থেকে মুছুন)' });
      const { data: slip } = await supabase.from('dayend_slips').select('slip_no').or('return_tx_id.eq.' + txId + ',damage_tx_id.eq.' + txId).limit(1);
      if (slip && slip.length) return res.json({ ok: false, error: 'এটি হিসাব ' + slip[0].slip_no + '-এর অংশ — হিসাবের তালিকা থেকে হিসাবটি মুছুন' });
      if (type === 'damage') {
        const { data: cl } = await supabase.from('dmg_claims').select('status').eq('tx_id', txId);
        if ((cl || []).some(c => c.status === 'cleared')) return res.json({ ok: false, error: 'এই ড্যামেজের দাবি কোম্পানি থেকে নিষ্পত্তি হয়ে গেছে — মোছা যাবে না' });
      }
      const err = await reverseStock(rows, await blockNegativeStock());
      if (err) return res.json({ ok: false, error: err });
      if (type === 'damage') await supabase.from('dmg_claims').delete().eq('tx_id', txId);
      const { error: de } = await supabase.from('transactions').delete().eq('tx_id', txId);
      if (de) throw de;
      await auditLog(OWNER, 'delete', 'transactions', txId, { type, rows: rows.length, date: ds(rows[0].date) }, null);
      return res.json({ ok: true });
    }
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) { res.json({ ok: false, error: safeErr(e) }); }
};
