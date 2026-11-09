// Day-end slip + manual DSR payments.
//   GET  ?action=prepare&dsrId=&date=   what the DSR carried that day + his due so far
//   POST {action:'dayend', ...}         save the whole slip atomically (damage[swap|cash], discount, commission, bonus, other, cash)
//                                        — every step must be answered yes/none in `checklist`, every damaged product must say swap or cash
//   POST {action:'cash', ...}           cash only (old due), no slip
//   GET  ?action=slips | slip&id= | payments
//   DELETE ?action=slip&id=&pin=        undo a slip (stock + money go back)
const crypto = require('crypto');
const { supabase, cors, str, safeErr, num, ds, today, fetchAll, fetchUpTo, mapSlip, mapPayment, mapTx, getDueTotals, auditLog, idemRun } = require('./_lib/db');
const { requireAuth, needPin, withBiz } = require('./_lib/auth');
const { priceItems, txRow, reverseStock, r2, loadProducts, snapOf } = require('./_lib/money');
const { lineDeduction, grossOf } = require('./_lib/offer');
const { blockNegativeStock } = require('./_lib/db');
const OWNER = { id: 'owner', role: 'owner' };
// the five day-end steps: each one must be answered "yes (there is something)" or "none" before a slip can be saved
const CK_LABEL = { damage: 'ড্যামেজ', discount: 'ছাড়', commission: 'কমিশন', bonus: 'বোনাস', other: 'অন্যান্য' };
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

// ── v12 — what the DSR / SO SOLD that day and the company offer already taken off the shops' price ──
// Each give line was saved with its own offer deduction (revenue = gross − deduction, whole qualifying cases only); goods handed back
// reverse the matching part (stored on the return line). Everything here is READ from those stored lines — nothing is recalculated.
//   original = money before the offer (net pieces)   offer = deduction still standing   payable = original − offer  (= what the due holds)
async function offerBreakdown(srId, date, extraReturnLines) {
  const [{ data: given }, prior] = await Promise.all([
    supabase.from('transactions').select('product_id,product_name,sku,total_units,total_revenue,selling_price,rule_case_size,rule_bonus_cases_req,rule_bonus_free_units,rule_bonus_free_money')
      .eq('type', 'give').eq('sr_id', String(srId)).eq('date', date),
    standaloneReturns(srId, date)
  ]);
  const m = {};
  (given || []).forEach(r => {
    const k = String(r.product_id), u = num(r.total_units);
    const o = m[k] = m[k] || { productId: k, name: r.product_name, sku: r.sku, g: 0, gross: 0, off: 0, r: 0, rgross: 0, roff: 0, cs: 0 };
    if (num(r.rule_case_size) > 0) o.cs = num(r.rule_case_size);   // pieces-per-case saved on the line
    const d = lineDeduction(r);
    o.g += u; o.gross += num(r.total_revenue) + d; o.off += d;
  });
  (prior || []).forEach(r => { const o = m[String(r.product_id)]; if (!o) return; const d = lineDeduction(r); o.r += num(r.total_units); o.rgross += num(r.total_revenue) + d; o.roff += d; });
  (extraReturnLines || []).forEach(l => { const o = m[String(l.productId)]; if (!o) return; o.r += num(l.units); o.rgross += num(l.gross); o.roff += num(l.offerDeduction); });
  const items = Object.values(m).map(o => {
    const ret = Math.min(o.r, o.g), net = Math.max(0, o.g - ret);
    const original = r2(Math.max(0, o.gross - o.rgross)), offer = r2(Math.max(0, o.off - o.roff));
    return { productId: o.productId, name: o.name, sku: o.sku, caseSize: o.cs || undefined, givenUnits: o.g, returnUnits: ret, netUnits: net, original, offer, payable: r2(original - offer) };
  });
  const sum = (k) => r2(items.reduce((s, i) => s + i[k], 0));
  return { items, original: sum('original'), total: sum('offer'), payable: sum('payable') };
}

// sum of {label, amount} entries typed in a day-end tab
const sumEntries = (arr) => r2((Array.isArray(arr) ? arr : []).reduce((s, e) => s + Math.max(0, num(e && e.amount)), 0));
const cleanEntries = (arr) => (Array.isArray(arr) ? arr : []).filter(e => e && num(e.amount) > 0).slice(0, 100)
  .map(e => ({ label: str(e.label, 120), shopId: str(e.shopId, 60), note: str(e.note, 200), amount: money(e.amount) }));

module.exports = withBiz(async (req, res) => {
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
          supabase.from('dayend_slips').select('id,slip_no').eq('dsr_id', sr.id).eq('date', date)
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
        const offer = await offerBreakdown(sr.id, date);
        return res.json({ ok: true, sr, date, items, offer, givenAmt: r2(items.reduce((s, i) => s + i.amount, 0)), dueBefore: due, existingSlips: (ex || []).map(x => x.slip_no), existing: (ex || []).map(x => ({ id: String(x.id), slipNo: x.slip_no })),
          priorReturnAmt, priorReturns: Object.values(priorReturns).map(o => ({ productId: o.productId, name: o.name, units: o.units, amount: r2(o.amount) })) });
      }
      if (action === 'slips') {
        const from = DATE_RE.test(q.from || '') ? q.from : null, to = DATE_RE.test(q.to || '') ? q.to : null;
        const data = await fetchUpTo(() => {
          let qq = supabase.from('dayend_slips').select('*').order('created_at', { ascending: false }).order('id', { ascending: false });
          if (from) qq = qq.gte('date', from); if (to) qq = qq.lte('date', to);
          if (q.dsrId) qq = qq.eq('dsr_id', String(q.dsrId));
          return qq;
        }, Math.min(Number(q.limit) || 1000, 3000));
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
        const data = await fetchUpTo(() => {
          let qq = supabase.from('sr_payments').select('*').order('created_at', { ascending: false }).order('id', { ascending: false });
          if (from) qq = qq.gte('date', from); if (to) qq = qq.lte('date', to);
          if (q.srId) qq = qq.eq('sr_id', String(q.srId));
          return qq;
        }, Math.min(Number(q.limit) || 1000, 3000));
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
      // ONE day-end slip per DSR / SO per day — a second tap or a second try can never double the figures
      const { data: exSl } = await supabase.from('dayend_slips').select('slip_no').eq('dsr_id', sr.id).eq('date', date).limit(1);
      if (exSl && exSl.length) return res.json({ ok: false, already: true, error: sr.name + '-এর ' + date.split('-').reverse().join('/') + ' তারিখের দিনশেষ হিসাব ইতিমধ্যে হয়ে গেছে (' + exSl[0].slip_no + ') — একদিনে একবারই করা যায়। ভুল হলে "হিসাবের তালিকা" থেকে সেটি মুছে আবার করুন।' });
      // each tab sends its own list of entries; plain numbers are still accepted (old clients)
      const commList = cleanEntries(d.commissionItems), discList = cleanEntries(d.discountItems),
            bonusList = cleanEntries(d.bonusItems), otherList = cleanEntries(d.otherItems);
      const comm = Array.isArray(d.commissionItems) ? sumEntries(commList) : money(d.commission);
      const disc = Array.isArray(d.discountItems) ? sumEntries(discList) : money(d.discount);
      const bonus = sumEntries(bonusList), other = sumEntries(otherList), cash = money(d.cash);
      const retItems = (d.returns || []).filter(i => num(i.cases) + num(i.pcs) > 0);
      const dmgItems = (d.damages || []).filter(i => num(i.cases) + num(i.pcs) > 0);

      // ── every step must be answered: "there is something" (and it is written) or "there is nothing" ──
      const ck = d.checklist && typeof d.checklist === 'object' ? d.checklist : null;
      if (!ck) return res.json({ ok: false, error: 'অ্যাপের পাতাটি পুরনো — পাতা রিফ্রেশ (reload) করে আবার হিসাব করুন' });
      const has = { damage: dmgItems.length > 0, discount: discList.length > 0, commission: commList.length > 0, bonus: bonusList.length > 0, other: otherList.length > 0 };
      for (const k of Object.keys(CK_LABEL)) {
        if (ck[k] !== 'none' && ck[k] !== 'yes') return res.json({ ok: false, error: CK_LABEL[k] + ' — \"আছে\" নাকি \"নেই\" তা বেছে নিন' });
        if (ck[k] === 'none' && has[k]) return res.json({ ok: false, error: CK_LABEL[k] + ' — \"নেই\" চিহ্ন দেওয়া, অথচ তথ্য লেখা আছে' });
        if (ck[k] === 'yes' && !has[k]) return res.json({ ok: false, error: CK_LABEL[k] + ' — \"আছে\" চিহ্ন দেওয়া, অথচ কিছু লেখা হয়নি' });
      }
      if (d.cash === undefined || d.cash === null || d.cash === '') return res.json({ ok: false, error: 'নগদ জমার ঘরটি পূরণ করুন (কিছু না পেলে ০ লিখুন)' });
      // damaged goods: for EVERY product the owner must say what the DSR / SO did with the shop —
      //   swap : gave the shop fresh goods from his own load (no money came in for those pieces)
      //   cash : paid the shop money out of the cash he collected (his cash in hand is lower)
      const dmgMeta = dmgItems.map(i => ({ method: i.method === 'swap' ? 'swap' : (i.method === 'cash' ? 'cash' : ''), shopName: str(i.shopName, 120), shopId: str(i.shopId, 60) }));
      if (dmgMeta.some(m => !m.method)) return res.json({ ok: false, error: 'ড্যামেজ — প্রতিটি পণ্যের জন্য বেছে নিন: দোকানকে বদলে মাল দিয়েছে, নাকি টাকা ফেরত দিয়েছে' });
      if (!retItems.length && !dmgItems.length && !comm && !disc && !bonus && !other && !cash && d.confirmEmpty !== true) return res.json({ ok: false, error: 'হিসাবে কিছু লেখা হয়নি' });

      let ret = { ok: true, lines: [] }, dmg = { ok: true, lines: [] };
      if (retItems.length) ret = await priceItems(retItems, { type: 'return', srId: sr.id, date });
      if (!ret.ok) return res.json({ ok: false, error: 'ফেরত: ' + ret.error });
      const retUnits = {}; ret.lines.forEach(l => { retUnits[l.productId] = (retUnits[l.productId] || 0) + l.units; });   // v12: pieces already handed back in this same slip
      if (dmgItems.length) dmg = await priceItems(dmgItems, { type: 'damage', srId: sr.id, date, priorExtra: retUnits });
      if (!dmg.ok) return res.json({ ok: false, error: 'ড্যামেজ: ' + dmg.error });

      const sum = (ls) => r2(ls.reduce((s, l) => s + l.revenue, 0));
      const returnAmt = sum(ret.lines), damageAmt = sum(dmg.lines);
      // goods already handed back on the ফেরত page that day: they are in his due already, but they also lower the cash we expect
      const priorReturnAmt = r2((await standaloneReturns(sr.id, date)).reduce((s, r) => s + num(r.total_revenue), 0));
      const { data: giv } = await supabase.from('transactions').select('total_revenue').eq('type', 'give').eq('sr_id', sr.id).eq('date', date);
      const givenAmt = r2((giv || []).reduce((s, r) => s + num(r.total_revenue), 0));
      const expected = r2(givenAmt - priorReturnAmt - returnAmt - damageAmt - comm - disc - bonus - other);
      if (expected < -0.01) return res.json({ ok: false, error: 'প্রত্যাশিত নগদ ঋণাত্মক (৳' + expected + ') — ড্যামেজ/কমিশন/ছাড়/বোনাস/অন্যান্য মোট দেওয়া মালের চেয়ে বেশি হয়ে গেছে, আবার দেখুন' });
      const { due: dueBefore } = await dueOf(sr.id);
      const payTotal = r2(cash + comm + disc + bonus + other + damageAmt);
      if (r2(returnAmt + payTotal) > dueBefore + 0.01)
        return res.json({ ok: false, error: 'হিসাব বাকির চেয়ে বেশি হয়ে গেছে — বাকি ৳' + dueBefore + ', এই হিসাবে মোট ৳' + r2(returnAmt + payTotal) + '। ড্যামেজ/কমিশন/ছাড়/বোনাস/অন্যান্য/নগদ আবার দেখুন' });

      // what exactly happened to each damaged product (kept inside the slip, no extra table needed)
      const dmgDetail = dmg.lines.map((l, i) => ({ productId: l.productId, name: l.productName, sku: l.sku, units: l.units, cases: l.cases, pcs: l.pcs,
        amount: l.revenue, caseSize: l.snap.unitsPerCase, method: dmgMeta[i].method, shopId: dmgMeta[i].shopId, shopName: dmgMeta[i].shopName }));
      const damageSwapAmt = r2(dmgDetail.filter(x => x.method === 'swap').reduce((s, x) => s + x.amount, 0));
      const damageCashAmt = r2(dmgDetail.filter(x => x.method === 'cash').reduce((s, x) => s + x.amount, 0));
      const checks = {}; Object.keys(CK_LABEL).forEach(k => { checks[k] = ck[k]; });
      const offerCalc = await offerBreakdown(sr.id, date, ret.lines);   // what the system worked out (the owner's own bonus entries above are what was actually deducted)

      const now = new Date().toISOString();
      const retTx = crypto.randomUUID(), dmgTx = crypto.randomUUID();
      const baseR = { tx_id: retTx, type: 'return', sr_id: sr.id, sr_name: sr.name, date, slip_no: '', note: 'দিনশেষ হিসাব', created_at: now };
      const baseD = { tx_id: dmgTx, type: 'damage', sr_id: sr.id, sr_name: sr.name, date, slip_no: '', note: 'দিনশেষ হিসাব', created_at: now };
      const payload = {
        slip: { dsr_id: sr.id, dsr_name: sr.name, date, given_amt: givenAmt, return_amt: r2(priorReturnAmt + returnAmt), damage_amt: damageAmt, comm_amt: comm, disc_amt: disc, bonus_amt: bonus, other_amt: other,
          details: { commission: commList, discount: discList, bonus: bonusList, other: otherList, damage: dmgDetail, damageSwap: damageSwapAmt, damageCash: damageCashAmt, checks,
            offer: { items: offerCalc.items.filter(i => i.netUnits > 0), original: offerCalc.original, total: offerCalc.total, payable: offerCalc.payable } },
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
        returns: ret.lines.map(l => ({ productId: l.productId, name: l.productName, sku: l.sku, units: l.units, cases: l.cases, pcs: l.pcs, price: l.sellingPrice, amount: l.revenue, caseSize: l.snap.unitsPerCase })),
        damages: dmg.lines.map((l, i) => ({ productId: l.productId, name: l.productName, sku: l.sku, units: l.units, cases: l.cases, pcs: l.pcs, price: l.sellingPrice, amount: l.revenue, caseSize: l.snap.unitsPerCase, method: dmgMeta[i].method })) });
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
});
