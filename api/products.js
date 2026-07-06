const { supabase, cors, num, now_, mapProduct, str, safeErr } = require('./_lib/db');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase.from('products').select('*').order('created_at');
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
        created_at:          now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, id: data.id });
    }

    if (req.method === 'PUT') {
      const d = req.body;
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
