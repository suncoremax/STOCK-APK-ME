const { supabase, cors, num, now_, mapProduct, str, safeErr } = require('./_lib/db');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const action = req.query && req.query.action;

      // ── categories: distinct list of category labels already in use,
      // so the Add/Edit form can offer a pick-list instead of everyone
      // retyping (and slightly-misspelling) the same category name. ──
      if (action === 'categories') {
        const { data, error } = await supabase.from('products').select('category');
        if (error) throw error;
        const set = new Set();
        (data || []).forEach(r => { const c = String(r.category || '').trim(); if (c) set.add(c); });
        return res.json({ ok: true, categories: [...set].sort((a, b) => a.localeCompare(b, 'bn')) });
      }

      const { data, error } = await supabase.from('products').select('*').order('sort_order').order('created_at');
      if (error) throw error;
      return res.json((data || []).map(mapProduct));
    }

    if (req.method === 'POST') {
      const d = req.body;
      if (!d || !String(d.name || '').trim()) return res.json({ ok: false, error: 'পণ্যের নাম আবশ্যক' });
      // AXIION §7 — reverse price entry: the owner types the bulk
      // case/jar/poly price (case_price / case_purchase_price); the
      // per-piece price every transaction actually uses is derived here,
      // server-side, to full 4-decimal precision — never typed by hand.
      const caseSize          = num(d.caseSize) || 1;
      const casePrice         = num(d.casePrice);
      const casePurchasePrice = num(d.casePurchasePrice);
      if (casePrice < 0 || casePurchasePrice < 0) return res.json({ ok: false, error: 'মূল্য ঋণাত্মক হতে পারবে না' });
      const sp = +(casePrice / caseSize).toFixed(4);
      const pp = +(casePurchasePrice / caseSize).toFixed(4);

      // New products always land at the end of the manual ordering list.
      const { data: maxRow } = await supabase.from('products').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle();
      const nextOrder = (maxRow ? num(maxRow.sort_order) : 0) + 1;

      const { data, error } = await supabase.from('products').insert({
        name:                str(d.name, 200),
        sku:                 str(d.sku, 50).toUpperCase(),
        case_size:           caseSize,
        unit_type:           str(d.unitType || 'কেস', 50),
        case_price:          casePrice,
        case_purchase_price: casePurchasePrice,
        purchase_price:      pp,
        selling_price:       sp,
        bonus_free_units:    num(d.bonusFreeUnits),
        bonus_cases_req:     num(d.bonusCasesReq) || 1,
        bonus_free_money:    num(d.bonusFreeMoney),
        low_stock_alert:     num(d.lowStockAlert),
        thumb:               String(d.thumb || ''),
        category:            str(d.category || '', 100),
        sort_order:          nextOrder,
        created_at:          now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, id: data.id });
    }

    if (req.method === 'PUT') {
      const d = req.body;

      // ── REORDER — bulk re-write sort_order from a full ordered id list.
      // Sent whenever the Owner drags a product, taps ▲/▼, or types a
      // target position number ("move #26 to #5") in the product list —
      // the UI always recomputes the *entire* new order client-side first
      // (simple array move), then sends that whole list here so every
      // affected row's sort_order is rewritten in one shot, race-free. ──
      if (d.action === 'reorder') {
        const order = Array.isArray(d.order) ? d.order : [];
        if (!order.length) return res.json({ ok: false, error: 'order প্রয়োজন' });
        const updates = order.map((id, i) => supabase.from('products').update({ sort_order: i + 1 }).eq('id', id));
        const results = await Promise.all(updates);
        const failed = results.find(r => r.error);
        if (failed) throw failed.error;
        return res.json({ ok: true });
      }

      if (!d.id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      if (!String(d.name || '').trim()) return res.json({ ok: false, error: 'পণ্যের নাম আবশ্যক' });
      // AXIION §7 — same reverse price-entry logic as POST (see above).
      const caseSize          = num(d.caseSize) || 1;
      const casePrice         = num(d.casePrice);
      const casePurchasePrice = num(d.casePurchasePrice);
      if (casePrice < 0 || casePurchasePrice < 0) return res.json({ ok: false, error: 'মূল্য ঋণাত্মক হতে পারবে না' });
      const sp = +(casePrice / caseSize).toFixed(4);
      const pp = +(casePurchasePrice / caseSize).toFixed(4);
      let thumb = String(d.thumb || '');
      if (!thumb) {
        const { data: existing } = await supabase.from('products').select('thumb').eq('id', d.id).single();
        if (existing) thumb = existing.thumb || '';
      }
      const { error } = await supabase.from('products').update({
        name:                str(d.name, 200),
        sku:                 str(d.sku, 50).toUpperCase(),
        case_size:           caseSize,
        unit_type:           str(d.unitType || 'কেস', 50),
        case_price:          casePrice,
        case_purchase_price: casePurchasePrice,
        purchase_price:      pp,
        selling_price:       sp,
        bonus_free_units:    num(d.bonusFreeUnits),
        bonus_cases_req:     num(d.bonusCasesReq) || 1,
        bonus_free_money:    num(d.bonusFreeMoney),
        low_stock_alert:     num(d.lowStockAlert),
        category:            str(d.category || '', 100),
        thumb
      }).eq('id', d.id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const id = req.body?.id || req.query?.id;
      if (!id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      const { error } = await supabase.from('products').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
