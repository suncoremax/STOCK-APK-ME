// Day-end slip + manual DSR payments.
//   GET  ?action=prepare&dsrId=&date=   what the DSR carried that day + his due so far
//   POST {action:'dayend', ...}         save the whole slip atomically (returns, damage, commission, discount, cash)
//   POST {action:'cash', ...}           cash only (old due), no slip
//   GET  ?action=slips | slip&id= | payments
//   DELETE ?action=slip&id=&pin=        undo a slip (stock + money go back)
const crypto = require('crypto');
const { supabase, cors, str, safeErr, num, ds, today, fetchAll, mapSlip, mapPayment, mapTx, getDueTotals, auditLog, idemRun } = require('./_lib/db');
const { requireAuth, needPin } = require('./_lib/auth');
const { priceItems, txRow, reverseStock, r2 } = require('./_lib/money');
const { blockNegativeStock } = require('./_lib/db');
const OWNER = { id: 'owner', role: 'owner' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function dueOf(srId) {
  const t = (await getDueTotals([srId]))[srId] || { givenRev: 0, returnRev: 0, payments: 0 };
  return { due: r2(t.givenRev - t.returnRev - t.payments), t };
}
async function loadSr(id) {
  const { data } = await supabase.from('srs').select('id,name,role').eq('id', String(id || '')).maybeSingle();
  return data;
}
const money = (v) => Math.max(0, r2(num(v)));

// Returns typed on the stand-alone ফেরত page (not part of any day-end slip) for one DSR / SO on one day.
async function standaloneReturns(srId, date) {
  const [{ data: rets }, { data: slips }] = await Promise.all([
    supabase.from('transactions').select('*').eq('type', 'return').eq('sr_id', String(srId)).eq('date', date),
    supabase.from('dayend_slips').select('return_tx_id').eq('dsr_id', String(srId)).eq('date', date)
  ]);
  const owned = new Set((slips || []).map(s => s.return_tx_id).filter(Boolean));
  return (rets || []).filter(r => !owned.has(String(r.tx_id)));
}
// sum of {label, amount} entries typed in a day-end tab
const sumEntries = (arr) => r2((Array.isArray(arr) ? arr : []).reduce((s, e) => s + Math.max(0, num(e && e.amount)), 0));
const cleanEntries = (arr) => (Array.isArray(arr) ? arr : []).filter(e => e && num(e.amount) > 0).slice(0, 100)
  .map(e => ({ label: str(e.label, 120), shopId: str(e.shopId, 60), note: str(e.note, 200), amount: money(e.amount) }));

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const q = req.query || {};
  try {
    if (req.method === 'GET') {
      const action = q.action || 'slips';
      if (action === 'prepare') {
        const sr = await loadSr(q.dsrId);
        if (!sr) return res.json({ ok: false, error: 'DSR / SO পাওয়া যায়নি' });
        const date = DATE_RE.test(q.date || '') ? q.date : today();
        const [{ data: given }, { due }, { data: ex }] = await Promise.all([
          supabase.from('transactions').select('product_id,product_name,sku,total_units,total_revenue,cases,pcs').eq('type', 'give').eq('sr_id', sr.id).eq('date', date),
          dueOf(sr.id),
          supabase.from('dayend_slips').select('slip_no').eq('dsr_id', sr.id).eq('date', date)
        ]);
        const m = {};
        (given || []).forEach(r => {
          const k = String(r.product_id);
          const o = m[k] = m[k] || { productId: k, name: r.product_name, sku: r.sku, units: 0, amount: 0 };
          o.units += num(r.total_units); o.amount += num(r.total_revenue);
        });
        const items = Object.values(m).map(o => ({ productId: o.productId, name: o.name, sku: o.sku, units: o.units, amount: r2(o.amount) }));
        const prior = await standaloneReturns(sr.id, date);
        const priorReturnAmt = r2(prior.reduce((s, r) => s + num(r.total_revenue), 0));
        const priorReturns = {};
        prior.forEach(r => { const k = String(r.product_id); const o = priorReturns[k] = priorReturns[k] || { productId: k, name: r.product_name, units: 0, amount: 0 }; o.units += num(r.total_units); o.amount += num(r.total_revenue); });
        return res.json({ ok: true, sr, date, items, givenAmt: r2(items.reduce((s, i) => s + i.amount, 0)), dueBefore: due, existingSlips: (ex || []).map(x => x.slip_no),
          priorReturnAmt, priorReturns: Object.values(priorReturns).map(o => ({ productId: o.productId, name: o.name, units: o.units, amount: r2(o.amount) })) });
      }
      if (action === 'slips') {
        const from = DATE_RE.test(q.from || '') ? q.from : null, to = DATE_RE.test(q.to || '') ? q.to : null;
        let qq = supabase.from('dayend_slips').select('*').order('created_at', { ascending: false }).limit(Math.min(Number(q.limit) || 300, 2000));
        if (from) qq = qq.gte('date', from); if (to) qq = qq.lte('date', to);
        if (q.dsrId) qq = qq.eq('dsr_id', String(q.dsrId));
        const { data, error } = await qq; if (error) throw error;
        return res.json({ ok: true, slips: (data || []).map(mapSlip) });
      }
      if (action === 'slip') {
        const { data: s } = await supabase.from('dayend_slips').select('*').eq('id', String(q.id || '')).maybeSingle();
        if (!s) return res.json({ ok: false, error: 'হিসাব পাওয়া যায়নি' });
        const ids = [s.return_tx_id, s.damage_tx_id].filter(Boolean);
        const { data: tx } = ids.length ? await supabase.from('transactions').select('*').in('tx_id', ids) : { data: [] };
        const { data: giv } = await supabase.from('transactions').select('*').eq('type', 'give').eq('sr_id', s.dsr_id).eq('date', s.date);
        const extraRet = await standaloneReturns(s.dsr_id, String(s.date).slice(0, 10));
        const retRows = (tx || []).filter(r => r.type === 'return').concat(extraRet);
        return res.json({ ok: true, slip: mapSlip(s), returns: retRows.map(mapTx),
          damages: (tx || []).filter(r => r.type === 'damage').map(mapTx), given: (giv || []).map(mapTx) });
      }
      if (action === 'payments') {
        const from = DATE_RE.test(q.from || '') ? q.from : null, to = DATE_RE.test(q.to || '') ? q.to : null;
        let qq = supabase.from('sr_payments').select('*').order('created_at', { ascending: false }).limit(Math.min(Number(q.limit) || 500, 3000));
        if (from) qq = qq.gte('date', from); if (to) qq = qq.lte('date', to);
        if (q.srId) qq = qq.eq('sr_id', String(q.srId));
        const { data, error } = await qq; if (error) throw error;
        return res.json({ ok: true, payments: (data || []).map(mapPayment) });
      }
      return res.json({ ok: false, error: 'Unknown action' });
    }

    if (req.method === 'POST') return idemRun(req, res, 'pay', async () => {
      const d = req.body || {};
      const sr = await loadSr(d.dsrId);
      if (!sr) return res.json({ ok: false, error: 'DSR / SO বেছে নিন' });
      const date = DATE_RE.test(d.date || '') ? d.date : today();

      // ── cash only (collect an old balance) ──
      if (d.action === 'cash') {
        const cash = money(d.cash);
        if (cash <= 0) return res.json({ ok: false, error: 'টাকার পরিমাণ দিন' });
        const { due } = await dueOf(sr.id);
        if (cash > due + 0.01) return res.json({ ok: false, error: 'বাকি আছে মাত্র ৳' + due + ' — এর বেশি নেওয়া যাবে না' });
        const { data, error } = await supabase.from('sr_payments').insert({ sr_id: sr.id, sr_name: sr.name, date, amount: cash, cash_amount: cash,
          commission_amt: 0, discount_amt: 0, damage_amt: 0, note: str(d.note, 300) || 'পুরনো বাকি জমা' }).select().single();
        if (error) throw error;
        await auditLog(OWNER, 'create', 'sr_payments', data.id, null, data);
        return res.json({ ok: true, payment: mapPayment(data), dueAfter: r2(due - cash) });
      }

      // ── the day-end slip ──
      if (d.action !== 'dayend') return res.json({ ok: false, error: 'Unknown action' });
      // each tab sends its own list of entries; plain numbers are still accepted (old clients)
      const commList = cleanEntries(d.commissionItems), discList = cleanEntries(d.discountItems),
            bonusList = cleanEntries(d.bonusItems), otherList = cleanEntries(d.otherItems);
      const comm = Array.isArray(d.commissionItems) ? sumEntries(commList) : money(d.commission);
      const disc = Array.isArray(d.discountItems) ? sumEntries(discList) : money(d.discount);
      const bonus = sumEntries(bonusList), other = sumEntries(otherList), cash = money(d.cash);
      const retItems = (d.returns || []).filter(i => num(i.cases) + num(i.pcs) > 0);
      const dmgItems = (d.damages || []).filter(i => num(i.cases) + num(i.pcs) > 0);
      if (!retItems.length && !dmgItems.length && !comm && !disc && !bonus && !other && !cash) return res.json({ ok: false, error: 'হিসাবে কিছু লেখা হয়নি' });

      let ret = { ok: true, lines: [] }, dmg = { ok: true, lines: [] };
      if (retItems.length) ret = await priceItems(retItems, { type: 'return', srId: sr.id, date });
      if (!ret.ok) return res.json({ ok: false, error: 'ফেরত: ' + ret.error });
      if (dmgItems.length) dmg = await priceItems(dmgItems, { type: 'damage', srId: sr.id, date });
      if (!dmg.ok) return res.json({ ok: false, error: 'ড্যামেজ: ' + dmg.error });

      const sum = (ls) => r2(ls.reduce((s, l) => s + l.revenue, 0));
      const returnAmt = sum(ret.lines), damageAmt = sum(dmg.lines);
      // goods already handed back on the ফেরত page that day: they are in his due already, but they also lower the cash we expect
      const priorReturnAmt = r2((await standaloneReturns(sr.id, date)).reduce((s, r) => s + num(r.total_revenue), 0));
      const { data: giv } = await supabase.from('transactions').select('total_revenue').eq('type', 'give').eq('sr_id', sr.id).eq('date', date);
      const givenAmt = r2((giv || []).reduce((s, r) => s + num(r.total_revenue), 0));
      const expected = r2(givenAmt - priorReturnAmt - returnAmt - damageAmt - comm - disc - bonus - other);
      const { due: dueBefore } = await dueOf(sr.id);
      const payTotal = r2(cash + comm + disc + bonus + other + damageAmt);
      if (r2(returnAmt + payTotal) > dueBefore + 0.01)
        return res.json({ ok: false, error: 'হিসাব বাকির চেয়ে বেশি হয়ে গেছে — বাকি ৳' + dueBefore + ', এই হিসাবে মোট ৳' + r2(returnAmt + payTotal) + '। ড্যামেজ/কমিশন/ছাড়/বোনাস/অন্যান্য/নগদ আবার দেখুন' });

      const now = new Date().toISOString();
      const retTx = crypto.randomUUID(), dmgTx = crypto.randomUUID();
      const baseR = { tx_id: retTx, type: 'return', sr_id: sr.id, sr_name: sr.name, date, slip_no: '', note: 'দিনশেষ হিসাব', created_at: now };
      const baseD = { tx_id: dmgTx, type: 'damage', sr_id: sr.id, sr_name: sr.name, date, slip_no: '', note: 'দিনশেষ হিসাব', created_at: now };
      const payload = {
        slip: { dsr_id: sr.id, dsr_name: sr.name, date, given_amt: givenAmt, return_amt: r2(priorReturnAmt + returnAmt), damage_amt: damageAmt, comm_amt: comm, disc_amt: disc, bonus_amt: bonus, other_amt: other,
          details: { commission: commList, discount: discList, bonus: bonusList, other: otherList },
          expected_cash: expected, cash_amt: cash, due_before: dueBefore, due_after: r2(dueBefore - returnAmt - payTotal), note: str(d.note, 300),
          return_tx_id: ret.lines.length ? retTx : '', damage_tx_id: dmg.lines.length ? dmgTx : '', created_at: now },
        returns: ret.lines.map(l => txRow(l, baseR)),
        damages: dmg.lines.map(l => txRow(l, baseD)),
        claims: dmg.lines.map(l => ({ tx_id: dmgTx, product_id: l.productId, product_name: l.productName, sku: l.sku, total_units: l.units,
          purchase_price: l.purchasePrice, total_cost: l.cost, date, sr_id: sr.id, sr_name: sr.name, created_at: now })),
        payment: payTotal > 0 ? { sr_id: sr.id, sr_name: sr.name, date, amount: payTotal, cash_amount: cash, commission_amt: comm, discount_amt: disc,
          bonus_amt: bonus, other_amt: other, damage_amt: damageAmt, note: 'দিনশেষ হিসাব', created_at: now } : null
      };
      const { data, error } = await supabase.rpc('save_day_end', { p: payload });
      if (error) throw error;
      await auditLog(OWNER, 'create', 'dayend_slips', data && data.id, null, data);
      res.json({ ok: true, slip: mapSlip(data),
        returns: ret.lines.map(l => ({ productId: l.productId, name: l.productName, sku: l.sku, units: l.units, cases: l.cases, pcs: l.pcs, price: l.sellingPrice, amount: l.revenue, caseSize: num(l.prod.case_size) || 1 })),
        damages: dmg.lines.map(l => ({ productId: l.productId, name: l.productName, sku: l.sku, units: l.units, cases: l.cases, pcs: l.pcs, price: l.sellingPrice, amount: l.revenue, caseSize: num(l.prod.case_size) || 1 })) });
    });

    if (req.method === 'DELETE') {
      if (q.action === 'payment') {   // only a stand-alone cash entry (not part of a slip)
        if (!(await needPin(req, res, q.pin))) return;
        const id = String(q.id || '');
        const { data: used } = await supabase.from('dayend_slips').select('slip_no').eq('payment_id', id).limit(1);
        if (used && used.length) return res.json({ ok: false, error: 'এটি হিসাব ' + used[0].slip_no + '-এর অংশ — হিসাবের তালিকা থেকে হিসাবটি মুছুন' });
        const { error } = await supabase.from('sr_payments').delete().eq('id', id);
        if (error) throw error;
        await auditLog(OWNER, 'delete', 'sr_payments', id, null, null);
        return res.json({ ok: true });
      }
      if (q.action !== 'slip') return res.json({ ok: false, error: 'Unknown action' });
      if (!(await needPin(req, res, q.pin))) return;
      const { data: s } = await supabase.from('dayend_slips').select('*').eq('id', String(q.id || '')).maybeSingle();
      if (!s) return res.json({ ok: false, error: 'হিসাব পাওয়া যায়নি' });
      if (s.damage_tx_id) {
        const { data: cl } = await supabase.from('dmg_claims').select('status').eq('tx_id', s.damage_tx_id);
        if ((cl || []).some(c => c.status === 'cleared')) return res.json({ ok: false, error: 'এই হিসাবের ড্যামেজ দাবি কোম্পানি থেকে নিষ্পত্তি হয়ে গেছে — মোছা যাবে না' });
      }
      if (s.return_tx_id) {
        const { data: rows } = await supabase.from('transactions').select('*').eq('tx_id', s.return_tx_id);
        const err = await reverseStock(rows || [], await blockNegativeStock());
        if (err) return res.json({ ok: false, error: err });
        await supabase.from('transactions').delete().eq('tx_id', s.return_tx_id);
      }
      if (s.damage_tx_id) {
        await supabase.from('dmg_claims').delete().eq('tx_id', s.damage_tx_id);
        await supabase.from('transactions').delete().eq('tx_id', s.damage_tx_id);
      }
      if (s.payment_id) await supabase.from('sr_payments').delete().eq('id', s.payment_id);
      const { error } = await supabase.from('dayend_slips').delete().eq('id', s.id);
      if (error) throw error;
      await auditLog(OWNER, 'delete', 'dayend_slips', s.id, mapSlip(s), null);
      return res.json({ ok: true });
    }
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) { res.json({ ok: false, error: safeErr(e) }); }
};
