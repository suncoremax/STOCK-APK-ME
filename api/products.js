const { supabase, cors, num, now_, mapProduct } = require('./_lib/db');

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
      const { data, error } = await supabase.from('products').insert({
        name:             String(d.name || '').trim(),
        sku:              String(d.sku  || '').trim().toUpperCase(),
        case_size:        num(d.caseSize) || 1,
        unit_type:        String(d.unitType || 'কেস'),
        purchase_price:   num(d.purchasePrice),
        selling_price:    num(d.sellingPrice),
        bonus_free_units: num(d.bonusFreeUnits),
        bonus_cases_req:  num(d.bonusCasesReq) || 1,
        bonus_free_money: num(d.bonusFreeMoney),
        low_stock_alert:  num(d.lowStockAlert),
        thumb:            String(d.thumb || ''),
        created_at:       now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, id: data.id });
    }

    if (req.method === 'PUT') {
      const d = req.body;
      if (!d.id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      let thumb = String(d.thumb || '');
      if (!thumb) {
        const { data: existing } = await supabase.from('products').select('thumb').eq('id', d.id).single();
        if (existing) thumb = existing.thumb || '';
      }
      const { error } = await supabase.from('products').update({
        name:             String(d.name || '').trim(),
        sku:              String(d.sku  || '').trim().toUpperCase(),
        case_size:        num(d.caseSize) || 1,
        unit_type:        String(d.unitType || 'কেস'),
        purchase_price:   num(d.purchasePrice),
        selling_price:    num(d.sellingPrice),
        bonus_free_units: num(d.bonusFreeUnits),
        bonus_cases_req:  num(d.bonusCasesReq) || 1,
        bonus_free_money: num(d.bonusFreeMoney),
        low_stock_alert:  num(d.lowStockAlert),
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
    res.json({ ok: false, error: e.message });
  }
};
