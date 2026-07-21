// claims.js — merged bonus.js + damage.js, routed by ?type=bonus | ?type=damage
// Logic below is copied unchanged from the original two files — only the
// routing wrapper (type= dispatch) is new. This merge frees one API-file
// slot under the 12-function Vercel Hobby limit (see AXIION blueprint §3).
const { supabase, cors, num, today, now_, computeBonusSummary, mapDmg, safeErr } = require('./_lib/db');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const type = (req.query && req.query.type) || '';

  try {
    if (type === 'bonus') return await handleBonus(req, res);
    if (type === 'damage') return await handleDamage(req, res);
    return res.json({ ok: false, error: 'type=bonus বা type=damage প্রয়োজন' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};

// ══════════════════════════════════════════════════
//  BONUS (was bonus.js) — unchanged logic
// ══════════════════════════════════════════════════
async function handleBonus(req, res) {
  // GET — bonus summary per product
  if (req.method === 'GET') {
    const summary = await computeBonusSummary();
    return res.json(summary);
  }

  // POST — record bonus payment (resets counter for that product)
  if (req.method === 'POST') {
    const productId = req.body?.productId;
    if (!productId) return res.json({ ok: false, error: 'productId প্রয়োজন' });

    const summary = await computeBonusSummary();
    const s = summary.find(x => String(x.productId) === String(productId));

    if (!s)               return res.json({ ok: false, error: 'পণ্য পাওয়া যায়নি' });
    if (s.accAmount <= 0) return res.json({ ok: false, error: 'কোনো বোনাস জমা হয়নি' });

    const td = today();
    const { error } = await supabase.from('bonus').insert({
      product_id:   productId,
      product_name: s.name,
      sku:          s.sku,
      from_date:    s.fromDate,
      to_date:      td,
      given_units:  s.totalGiven,
      bonus_amount: s.accAmount,
      status:       'cleared',
      cleared_date: td,
      note:         '',
      created_at:   now_()
    });
    if (error) throw error;
    return res.json({ ok: true, amount: s.accAmount });
  }

  res.status(405).json({ ok: false, error: 'Method not allowed' });
}

// ══════════════════════════════════════════════════
//  DAMAGE (was damage.js) — unchanged logic
// ══════════════════════════════════════════════════
async function handleDamage(req, res) {
  // GET — damage claims grouped by product
  if (req.method === 'GET') {
    const [dmgRes, prodRes] = await Promise.all([
      supabase.from('dmg_claims').select('*').order('created_at'),
      supabase.from('products').select('id,thumb')
    ]);
    const claims = (dmgRes.data || []).map(mapDmg);
    const prodThumbMap = {};
    (prodRes.data || []).forEach(p => { prodThumbMap[String(p.id)] = p.thumb || ''; });

    const map = {};
    claims.forEach(c => {
      const pid = c.productId; if (!pid) return;
      if (!map[pid]) map[pid] = {
        productId: pid, name: c.productName, sku: c.sku, thumb: '',
        pendingUnits: 0, pendingCost: 0, clearedUnits: 0, clearedCost: 0, lastClearedDate: ''
      };
      const u = num(c.totalUnits), cost = num(c.totalCost);
      if (c.status === 'cleared') {
        map[pid].clearedUnits += u; map[pid].clearedCost += cost;
        if (c.clearedDate && c.clearedDate > map[pid].lastClearedDate)
          map[pid].lastClearedDate = c.clearedDate;
      } else {
        map[pid].pendingUnits += u; map[pid].pendingCost += cost;
      }
    });
    Object.values(map).forEach(m => { if (prodThumbMap[m.productId]) m.thumb = prodThumbMap[m.productId]; });
    return res.json(Object.values(map).sort((a, b) => b.pendingCost - a.pendingCost));
  }

  // POST — clear all pending damage claims for a product
  if (req.method === 'POST') {
    const productId = req.body?.productId;
    if (!productId) return res.json({ ok: false, error: 'productId প্রয়োজন' });

    const { data: pending, error: fetchErr } = await supabase
      .from('dmg_claims').select('id,total_cost')
      .eq('product_id', productId).eq('status', 'pending');
    if (fetchErr) throw fetchErr;
    if (!pending || !pending.length) return res.json({ ok: true, totalCleared: 0 });

    const totalCleared = pending.reduce((s, r) => s + num(r.total_cost), 0);
    const { error: updErr } = await supabase.from('dmg_claims')
      .update({ status: 'cleared', cleared_date: today() })
      .in('id', pending.map(r => r.id));
    if (updErr) throw updErr;
    return res.json({ ok: true, totalCleared });
  }

  res.status(405).json({ ok: false, error: 'Method not allowed' });
}
