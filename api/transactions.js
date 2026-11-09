// Stock movements typed by the owner: কেনা (buy) · দেওয়া (give) · ফেরত (return) · কোম্পানিতে ফেরত (return_company) · ড্যামেজ (damage)
// (Direct shop sales live in shops.js; the full day-end slip lives in payments.js.)
const crypto = require('crypto');
const { supabase, cors, str, safeErr, num, ds, today, fetchAll, fetchUpTo, mapTx, auditLog, idemRun, blockNegativeStock, getDueTotals } = require('./_lib/db');
const { requireAuth, needPin, withBiz } = require('./_lib/auth');
const { priceItems, txRow, stockShortage, reverseStock, r2, lineOffer, loadProducts } = require('./_lib/money');
const { loadHistory, valueAt } = require('./_lib/history');
const OWNER = { id: 'owner', role: 'owner' };
const TYPES = ['buy', 'give', 'return', 'return_company', 'damage'];
const NEEDS_SR = { give: 1, return: 1, damage: 1 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── v11 LEGACY FREEZE ──────────────────────────────────────────────────────────────────────────
// An OLD line = a transactions row whose snapshot columns (rule_case_size …) are still empty. Freezing writes its own
// sellPrice / buyPrice / unitsPerCase onto the line (offer = 0) so that nothing can ever recalculate it from today's product.
// Safe to repeat and safe with two tabs: only rows whose rule_case_size IS NULL are ever selected or written.
const FREEZE_BATCH = 600;
async function freezePending() {
  const { count, error } = await supabase.from('transactions').select('id', { count: 'exact', head: true }).is('rule_case_size', null);
  if (error) throw error;
  return count || 0;
}
async function freezeBatch() {
  const { data: rows, error } = await supabase.from('transactions').select('*').is('rule_case_size', null).order('created_at').limit(FREEZE_BATCH);
  if (error) throw error;
  if (!rows || !rows.length) return { frozen: 0, skipped: 0 };
  const [prods, hist] = await Promise.all([loadProducts(rows.map(r => r.product_id)), loadHistory('')]);
  const groups = {};
  rows.forEach(r => {
    const pid = String(r.product_id), p = prods[pid], when = r.created_at || (String(r.date).slice(0, 10) + 'T23:59:59Z');
    const cs = num(valueAt(hist, pid, 'unitsPerCase', when, p ? p.case_size : 1)) || 1;
    const fill = {};   // the line normally already has its own prices — only a missing one is taken from history / the product
    if (!(num(r.selling_price) > 0) && p) fill.selling_price = num(valueAt(hist, pid, 'sellPrice', when, p.selling_price));
    if (!(num(r.purchase_price) > 0) && p) fill.purchase_price = num(valueAt(hist, pid, 'buyPrice', when, p.purchase_price));
    const key = cs + '|' + JSON.stringify(fill) + (Object.keys(fill).length ? '|' + r.id : '');
    (groups[key] = groups[key] || { cs, fill, ids: [] }).ids.push(r.id);
  });
  const stamp = new Date().toISOString();
  let frozen = 0;
  for (const g of Object.values(groups)) {
    const base = Object.assign({ rule_case_size: g.cs, rule_bonus_cases_req: 0, rule_bonus_free_units: 0, rule_bonus_free_money: 0 }, g.fill);
    for (let i = 0; i < g.ids.length; i += 100) {
      const ids = g.ids.slice(i, i + 100);
      // legacy / frozen_at columns exist only after the optional migration — try with them, fall back without
      let res = await supabase.from('transactions').update(Object.assign({ legacy: true, frozen_at: stamp }, base)).in('id', ids).is('rule_case_size', null).select('id');
      if (res.error && /legacy|frozen_at|column|schema cache/i.test(String(res.error.message || ''))) res = await supabase.from('transactions').update(base).in('id', ids).is('rule_case_size', null).select('id');
      if (res.error) throw res.error;
      frozen += (res.data || []).length;
    }
  }
  return { frozen, skipped: rows.length - frozen };
}

module.exports = withBiz(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  try {
    // ── list (filters: from,to,type,srId,limit) ──
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.action === 'freeze-status') {
        const pending = await freezePending();
        let lastAt = '';
        try { const { data } = await supabase.from('audit_log').select('at').eq('action', 'legacy_freeze').order('at', { ascending: false }).limit(1); lastAt = (data && data[0] && data[0].at) || ''; } catch (e) {}
        return res.json({ ok: true, pending, done: pending === 0, lastFrozenAt: lastAt });
      }
      if (q.action === 'freeze-backup') {   // JSON safety copy: every old line that the freeze would touch, plus the product list
        const [lines, prods] = await Promise.all([
          fetchAll(() => supabase.from('transactions').select('*').is('rule_case_size', null)),
          fetchAll(() => supabase.from('products').select('*'))
        ]);
        return res.json({ ok: true, backup: { kind: 'axiion-legacy-freeze-backup', at: new Date().toISOString(), lines, products: prods } });
      }
      const from = DATE_RE.test(q.from || '') ? q.from : null, to = DATE_RE.test(q.to || '') ? q.to : null;
      const limit = Math.min(Number(q.limit) || 1500, 5000);
      const mk = () => {
        let query = supabase.from('transactions').select('*').order('created_at', { ascending: false }).order('id', { ascending: false });
        if (from) query = query.gte('date', from);
        if (to) query = query.lte('date', to);
        if (q.type) query = query.in('type', String(q.type).split(','));
        if (q.srId) query = query.eq('sr_id', String(q.srId));
        if (q.shopId) query = query.eq('shop_id', String(q.shopId));
        if (q.txId) query = query.eq('tx_id', String(q.txId));   // one memo only (reprint)
        return query;
      };
      const data = await fetchUpTo(mk, q.txId ? 500 : limit);   // honours limits above 1000
      return res.json({ ok: true, transactions: (data || []).map(mapTx) });
    }

    if (req.method === 'POST' && req.body && req.body.action === 'freeze-legacy') {   // owner confirmed in the dialog / settings button
      const r = await freezeBatch();
      const remaining = await freezePending();
      if (r.frozen > 0 || remaining === 0) await auditLog(OWNER, 'legacy_freeze', 'transactions', '', null, { frozen: r.frozen, remaining });
      return res.json({ ok: true, frozen: r.frozen, remaining, done: remaining === 0 });
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
      // ONE load and ONE return per DSR / SO per day — so a double tap or a second try can never double the figures.
      // (made a mistake? delete the entry from the list below, then write it again)
      if (type === 'give' || type === 'return') {
        const { data: ex, error: exErr } = await supabase.from('transactions').select('tx_id').eq('type', type).eq('sr_id', srId).eq('date', date).limit(1);
        if (exErr) throw exErr;
        if (ex && ex.length) return res.json({ ok: false, already: true, error: srName + '-কে ' + date.split('-').reverse().join('/') + ' তারিখে ইতিমধ্যে ' + (type === 'give' ? 'মাল দেওয়া' : 'ফেরত নেওয়া') + ' হয়েছে — একদিনে একবারই লেখা যায়। ভুল হলে নিচের তালিকা থেকে সেটি মুছে আবার লিখুন।' });
        const seen = new Set();
        for (const it of (Array.isArray(d.items) ? d.items : [])) {
          const k = String((it && it.productId) || ''); if (!k) continue;
          if (seen.has(k)) return res.json({ ok: false, error: 'একই পণ্য দুইবার বাছা হয়েছে — প্রতিটি পণ্য একবারই লিখুন (পরিমাণ যোগ করে দিন)' });
          seen.add(k);
        }
      }
      const pr = await priceItems(d.items, { type, srId, date });
      if (!pr.ok) return res.json({ ok: false, error: pr.error });
      if (type === 'return') {   // goods handed back reduce his due — never below zero
        const tt = (await getDueTotals([srId]))[srId] || { givenRev: 0, returnRev: 0, payments: 0 };
        const due = r2(tt.givenRev - tt.returnRev - tt.payments), amt = r2(pr.lines.reduce((s, l) => s + l.revenue, 0));
        if (amt > due + 0.01) return res.json({ ok: false, error: 'ফেরতের মূল্য ৳' + amt + ', কিন্তু ' + srName + '-এর বাকি আছে মাত্র ৳' + due });
      }
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
      const offer = (type === 'give' || type === 'return' || type === 'damage') ? r2(pr.lines.reduce((x, l) => x + lineOffer(l), 0)) : 0;   // v12: offer already taken off (give) / handed back (return)
      const grossBefore = r2(pr.lines.reduce((x, l) => x + l.gross, 0));
      res.json({ ok: true, txId, date, type, srName, total, offer, grossBeforeOffer: grossBefore, rows: rows.map(r => mapTx(Object.assign({ id: '', created_at: new Date().toISOString() }, r))) });
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
});
