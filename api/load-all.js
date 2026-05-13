const { supabase, cors, mapProduct, mapSR, mapTx, calcStock } = require('./_lib/db');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const [pRes, sRes, tRes] = await Promise.all([
      supabase.from('products').select('*').order('created_at'),
      supabase.from('srs').select('*').order('created_at'),
      supabase.from('transactions').select('tx_id,type,product_id,total_units').order('created_at')
    ]);
    const products = (pRes.data || []).map(mapProduct);
    const srs      = (sRes.data || []).map(mapSR);
    const allTx    = (tRes.data || []).map(r => ({
      txId: String(r.tx_id || ''), type: r.type || '',
      productId: String(r.product_id || ''), totalUnits: String(r.total_units || 0)
    }));
    res.json({ ok: true, products, srs, stockMap: calcStock(allTx) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
};
