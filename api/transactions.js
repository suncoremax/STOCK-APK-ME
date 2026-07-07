const { supabase, cors, num, now_, mapTx, safeErr } = require('./_lib/db');
const { randomUUID } = require('crypto');

const VALID_TYPES = new Set(['buy','give','return','damage','point_sale','point_damage_return','dsr_sale']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // POST — add transaction (one or many items share same txId)
    if (req.method === 'POST') {
      const d = req.body;
      if (!VALID_TYPES.has(d.type)) return res.json({ ok: false, error: 'অবৈধ লেনদেনের ধরন' });
      if (!d.date || !DATE_RE.test(d.date)) return res.json({ ok: false, error: 'বৈধ তারিখ দিন (YYYY-MM-DD)' });
      if (!Array.isArray(d.items) || !d.items.length) return res.json({ ok: false, error: 'কমপক্ষে একটি আইটেম দিন' });
      if (d.items.length > 100) return res.json({ ok: false, error: 'একসাথে সর্বোচ্চ ১০০টি আইটেম' });
      const txId = randomUUID();
      const ts   = now_();

      const rows = (d.items || []).map(item => {
        const u  = num(item.totalUnits);
        const pp = num(item.purchasePrice);
        const sp = num(item.sellingPrice);
        return {
          tx_id:         txId,
          type:          d.type,
          sr_id:         d.srId   || '',
          sr_name:       d.srName || '',
          date:          d.date,
          slip_no:       d.slipNo || '',
          product_id:    String(item.productId  || ''),
          product_name:  String(item.productName|| ''),
          sku:           String(item.sku        || ''),
          cases:         num(item.cases),
          pcs:           num(item.pcs),
          total_units:   u,
          purchase_price: pp,
          selling_price:  sp,
          total_cost:    u * pp,
          total_revenue: u * sp,
          note:          d.note || '',
          created_at:    ts
        };
      });

      const { error: txErr } = await supabase.from('transactions').insert(rows);
      if (txErr) throw txErr;

      // Auto-create damage claims for 'damage' type
      if (d.type === 'damage') {
        const dmgRows = (d.items || []).map(item => {
          const u  = num(item.totalUnits);
          const pp = num(item.purchasePrice);
          return {
            tx_id:         txId,
            product_id:    String(item.productId   || ''),
            product_name:  String(item.productName || ''),
            sku:           String(item.sku         || ''),
            total_units:   u,
            purchase_price: pp,
            total_cost:    u * pp,
            date:          d.date,
            sr_id:         d.srId   || '',
            sr_name:       d.srName || '',
            status:        'pending',
            cleared_date:  null,
            created_at:    ts
          };
        });
        const { error: dmgErr } = await supabase.from('dmg_claims').insert(dmgRows);
        if (dmgErr) throw dmgErr;
      }

      return res.json({ ok: true, txId });
    }

    // GET — list transactions with optional filters
    // ?srId=<id>   → filter by a single sr_id (DSR isolation)
    // ?soId=<id>   → filter by SO: includes SO's own tx + all assigned DSRs' tx
    // ?from=&to=   → date range filter
    if (req.method === 'GET') {
      const { from, to, srId, soId } = req.query;

      if (soId) {
        // Resolve DSRs assigned to this SO
        const { data: dsrsData } = await supabase
          .from('srs').select('id').eq('so_id', soId);
        const dsrIds = (dsrsData || []).map(d => d.id);
        // Include the SO's own transactions as well
        const allIds = [soId, ...dsrIds];

        let q = supabase.from('transactions').select('*').order('created_at', { ascending: false });
        if (from) q = q.gte('date', from);
        if (to)   q = q.lte('date', to);
        if (allIds.length) q = q.in('sr_id', allIds);
        const { data, error } = await q;
        if (error) throw error;
        return res.json((data || []).map(mapTx));
      }

      // AXIION §8 — newest transaction first (was ascending, causing
      // today's newest entry to appear at the very bottom of the list).
      let q = supabase.from('transactions').select('*').order('created_at', { ascending: false });
      if (from) q = q.gte('date', from);
      if (to)   q = q.lte('date', to);
      if (srId) q = q.eq('sr_id', srId);
      const { data, error } = await q;
      if (error) throw error;
      return res.json((data || []).map(mapTx));
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
