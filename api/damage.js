const { supabase, cors, num, today, mapDmg } = require('./_lib/db');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
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
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
};
