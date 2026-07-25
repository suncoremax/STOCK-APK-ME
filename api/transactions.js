const { supabase, cors, num, now_, mapTx, safeErr, fetchAll } = require('./_lib/db');
const { randomUUID } = require('crypto');

const VALID_TYPES = new Set(['buy','give','return','damage','point_sale','point_damage_return','dsr_sale']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Update #49 — DSR/SO due-history modal: given a set of transaction
// rows (already filtered to one sr_id) that have a shop_id set, resolve
// those ids to shop names in one batched query instead of one lookup
// per row.
async function _resolveShopNames(shopIds) {
  const ids = [...new Set(shopIds.filter(Boolean))];
  if (!ids.length) return {};
  const { data, error } = await supabase.from('shops').select('id,name').in('id', ids);
  if (error) throw error;
  const map = {};
  (data || []).forEach(s => { map[String(s.id)] = s.name || ''; });
  return map;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const action = (req.query && req.query.action) || '';

    // ══════════════════════════════════════════════════
    //  Update #49 — DSR/SO due transaction history
    //  GET /api/transactions?action=due-history&srId=<id>
    //  Returns every give/return transaction (the same rows that make
    //  up that SR's due total on the dashboard) plus every payment made
    //  against them, newest first — source, date, product, shop (when
    //  set) and amount for each — so tapping the due figure shows the
    //  full "why" behind the number, not just the total.
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'due-history') {
      const srId = String(req.query.srId || '');
      if (!srId) return res.json({ ok: false, error: 'srId আবশ্যক' });

      const [txRows, payRows] = await Promise.all([
        fetchAll(() => supabase.from('transactions').select('*').eq('sr_id', srId).in('type', ['give', 'return']).order('date', { ascending: false })),
        fetchAll(() => supabase.from('sr_payments').select('*').eq('sr_id', srId).order('date', { ascending: false }))
      ]);
      const txs  = (txRows  || []).map(mapTx);
      const pays = (payRows || []);

      const shopMap = await _resolveShopNames(txs.map(t => t.shopId));

      const rows = [];
      txs.forEach(t => {
        rows.push({
          source: t.type,                                   // 'give' | 'return'
          date: t.date,
          productName: t.productName,
          totalUnits: num(t.totalUnits),
          shopName: t.shopId ? (shopMap[t.shopId] || '') : '',
          amount: num(t.totalRevenue)
        });
      });
      pays.forEach(p => {
        rows.push({
          source: 'payment',
          date: p.date ? String(p.date).slice(0, 10) : '',
          productName: '',
          totalUnits: 0,
          shopName: '',
          amount: num(p.amount)
        });
      });
      rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

      const givenRev  = txs.filter(t => t.type === 'give').reduce((s, t) => s + num(t.totalRevenue), 0);
      const returnRev = txs.filter(t => t.type === 'return').reduce((s, t) => s + num(t.totalRevenue), 0);
      const payments  = pays.reduce((s, p) => s + num(p.amount), 0);
      const due       = (givenRev - returnRev) - payments;

      return res.json({ ok: true, srId, rows, totals: { givenRev, returnRev, payments, due } });
    }

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
          // Update #51 — point-sale rows now carry a real shop_id (when
          // the phone number matched an existing registered shop) or a
          // customer_id (pointing at a proper pos_customers record)
          // instead of only ever landing in the free-text `note` field.
          shop_id:       d.shopId     || '',
          customer_id:   d.customerId || '',
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

        const rows = await fetchAll(() => {
          let q = supabase.from('transactions').select('*').order('created_at', { ascending: false });
          if (from) q = q.gte('date', from);
          if (to)   q = q.lte('date', to);
          if (allIds.length) q = q.in('sr_id', allIds);
          return q;
        });
        return res.json((rows || []).map(mapTx));
      }

      // AXIION §8 — newest transaction first (was ascending, causing
      // today's newest entry to appear at the very bottom of the list).
      // Paginated (fetchAll): without from/to this is a full-table list,
      // which would otherwise silently truncate at 1000 rows.
      const rows = await fetchAll(() => {
        let q = supabase.from('transactions').select('*').order('created_at', { ascending: false });
        if (from) q = q.gte('date', from);
        if (to)   q = q.lte('date', to);
        if (srId) q = q.eq('sr_id', srId);
        return q;
      });
      return res.json((rows || []).map(mapTx));
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
