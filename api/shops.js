// shops.js — AXIION Blueprint §3 (new file, 11/12 slot) + §11 route surface
//
// Backend surface for the Shop Registry / QR / Point-of-Sale module. This
// file wires up every action listed in §3's API map so the 12-file
// structure is complete and testable; the dedicated §11 UI screens (QR
// scan, nearest-shop picker, visit workflow) are a separate front-end
// phase that will call straight into these same endpoints.
const { randomUUID } = require('crypto');
const {
  supabase, cors, num, now_, str, safeErr,
  mapShop, mapDue, mapTx
} = require('./_lib/db');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  try {
    // ══════════════════════════════════════════════════
    //  REGISTER — Owner registers a shop under a DSR
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'register') {
      const d = req.body;
      if (!String(d.name || '').trim()) return res.json({ ok: false, error: 'দোকানের নাম আবশ্যক' });
      if (!d.assignedDsrId) return res.json({ ok: false, error: 'DSR নির্বাচন আবশ্যক' });

      const { data: seq, error: seqErr } = await supabase.rpc('next_shop_no');
      if (seqErr) throw seqErr;
      const shopNo = 'SHOP-' + String(seq).padStart(4, '0');

      const { data: dsr } = await supabase.from('srs').select('name').eq('id', d.assignedDsrId).single();

      const { data, error } = await supabase.from('shops').insert({
        id:               randomUUID(),
        shop_no:          shopNo,
        name:             str(d.name, 200),
        phone:            str(d.phone, 30),
        address:          str(d.address, 300),
        lat:              d.lat != null ? num(d.lat) : null,
        lng:              d.lng != null ? num(d.lng) : null,
        assigned_dsr_id:  String(d.assignedDsrId),
        assigned_dsr_name: dsr ? dsr.name : '',
        created_at:       now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, shop: mapShop(data) });
    }

    // ══════════════════════════════════════════════════
    //  LIST / SEARCH — by number, name, DSR, or GPS proximity
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && (action === 'list' || action === 'search')) {
      const { q, dsrId, lat, lng, limit } = req.query;
      let query = supabase.from('shops').select('*').order('created_at', { ascending: false });
      if (dsrId) query = query.eq('assigned_dsr_id', dsrId);
      const { data, error } = await query;
      if (error) throw error;
      let shops = (data || []).map(mapShop);

      if (q) {
        const needle = String(q).trim().toLowerCase();
        shops = shops.filter(s =>
          s.shopNo.toLowerCase().includes(needle) ||
          s.name.toLowerCase().includes(needle) ||
          s.phone.includes(needle) ||
          s.assignedDsrName.toLowerCase().includes(needle) ||
          s.address.toLowerCase().includes(needle)
        );
      }

      // Free GPS-proximity sort — simple haversine, no paid "nearby search" API
      if (lat && lng) {
        const la = num(lat), ln = num(lng);
        const dist = (a, b) => {
          if (a.lat == null || a.lng == null) return Infinity;
          const R = 6371000;
          const dLat = (a.lat - b.lat) * Math.PI / 180;
          const dLng = (a.lng - b.lng) * Math.PI / 180;
          const s = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
          return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
        };
        shops = shops
          .map(s => ({ ...s, distanceM: dist(s, { lat: la, lng: ln }) }))
          .sort((a, b) => a.distanceM - b.distanceM);
      }

      if (limit) shops = shops.slice(0, num(limit));
      return res.json({ ok: true, shops });
    }

    // ══════════════════════════════════════════════════
    //  DETAIL — full shop profile: due history + sales history
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'detail') {
      const { shopId } = req.query;
      if (!shopId) return res.json({ ok: false, error: 'shopId প্রয়োজন' });
      const { data: shopRow, error: shopErr } = await supabase.from('shops').select('*').eq('id', shopId).single();
      if (shopErr) throw shopErr;
      if (!shopRow) return res.json({ ok: false, error: 'দোকান পাওয়া যায়নি' });

      const [dueRes, txRes] = await Promise.all([
        supabase.from('due_calendar').select('*').eq('shop_id', shopId).order('due_date', { ascending: false }),
        supabase.from('transactions').select('*').eq('shop_id', shopId).order('created_at', { ascending: false })
      ]);
      const dues  = (dueRes.data || []).map(mapDue);
      const sales = (txRes.data  || []).map(mapTx);
      const totalDue = dues.filter(d => d.status !== 'cleared').reduce((s, d) => s + (num(d.amount) - num(d.paidAmount)), 0);

      return res.json({ ok: true, shop: mapShop(shopRow), dues, sales, totalDue });
    }

    // ══════════════════════════════════════════════════
    //  VISIT-SALE — DSR sells to a shop: due reminder already shown
    //  client-side from `detail`; this records the sale + payment split
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'visit-sale') {
      const d = req.body;
      if (!d.shopId || !d.dsrId) return res.json({ ok: false, error: 'shopId ও dsrId প্রয়োজন' });
      const items = Array.isArray(d.items) ? d.items : [];
      if (!items.length) return res.json({ ok: false, error: 'অন্তত একটি পণ্য প্রয়োজন' });

      const txId = randomUUID();
      const date = d.date || now_().slice(0, 10);
      const rows = items.map(item => {
        const u = num(item.totalUnits), sp = num(item.sellingPrice), pp = num(item.purchasePrice);
        return {
          tx_id: txId, type: 'point_sale',
          sr_id: String(d.dsrId), sr_name: d.dsrName || '',
          date, slip_no: d.slipNo || '',
          product_id: String(item.productId || ''), product_name: String(item.productName || ''),
          sku: String(item.sku || ''), cases: num(item.cases), pcs: num(item.pcs),
          total_units: u, purchase_price: pp, selling_price: sp,
          total_cost: u * pp, total_revenue: u * sp,
          shop_id: String(d.shopId), note: d.note || '',
          created_at: now_()
        };
      });
      const { error: txErr } = await supabase.from('transactions').insert(rows);
      if (txErr) throw txErr;

      const payable  = rows.reduce((s, r) => s + num(r.total_revenue), 0) - num(d.discountAmt || 0) - num(d.commissionAmt || 0);
      const paidNow  = num(d.paidAmount);
      const shortfall = +(payable - paidNow).toFixed(4);

      let due = null;
      if (shortfall > 0) {
        const { data: shopRow } = await supabase.from('shops').select('name').eq('id', d.shopId).single();
        const { data: dueRow, error: dueErr } = await supabase.from('due_calendar').insert({
          id: randomUUID(), dsr_id: String(d.dsrId), dsr_name: d.dsrName || '',
          client_type: 'shop', shop_id: String(d.shopId), shop_name: shopRow ? shopRow.name : '',
          due_date: date, amount: shortfall, paid_amount: 0,
          note: 'দোকান বিক্রয় বাকি', status: 'pending', created_at: now_()
        }).select().single();
        if (dueErr) throw dueErr;
        due = mapDue(dueRow);
      }

      return res.json({ ok: true, payable, paidNow, shortfall: Math.max(0, shortfall), due });
    }

    // ══════════════════════════════════════════════════
    //  CLEAR-PLATE — today's outstanding shop dues for one DSR
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'clear-plate') {
      const { dsrId } = req.query;
      if (!dsrId) return res.json({ ok: false, error: 'dsrId প্রয়োজন' });
      const today = now_().slice(0, 10);
      const { data, error } = await supabase.from('due_calendar')
        .select('*')
        .eq('client_type', 'shop').eq('dsr_id', dsrId).eq('due_date', today)
        .in('status', ['pending', 'partial'])
        .order('created_at');
      if (error) throw error;
      return res.json({ ok: true, plate: (data || []).map(mapDue) });
    }

    // ══════════════════════════════════════════════════
    //  POINT-SALE — walk-in / phone-number counter sale
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'point-sale') {
      const d = req.body;
      const items = Array.isArray(d.items) ? d.items : [];
      if (!items.length) return res.json({ ok: false, error: 'অন্তত একটি পণ্য প্রয়োজন' });

      // Look up an existing shop by phone number first (reuse §11 registry)
      let shopId = '', shopName = d.customerName || '';
      if (d.phone) {
        const { data: match } = await supabase.from('shops').select('id,name').eq('phone', String(d.phone)).limit(1);
        if (match && match.length) { shopId = match[0].id; shopName = match[0].name; }
      }

      const txId = randomUUID();
      const date = d.date || now_().slice(0, 10);
      const rows = items.map(item => {
        const u = num(item.totalUnits), sp = num(item.sellingPrice), pp = num(item.purchasePrice);
        return {
          tx_id: txId, type: 'point_sale',
          sr_id: String(d.handledBy || ''), sr_name: d.handledByName || '',
          date, slip_no: d.slipNo || '',
          product_id: String(item.productId || ''), product_name: String(item.productName || ''),
          sku: String(item.sku || ''), cases: num(item.cases), pcs: num(item.pcs),
          total_units: u, purchase_price: pp, selling_price: sp,
          total_cost: u * pp, total_revenue: u * sp,
          shop_id: shopId, note: shopName ? ('গ্রাহক: ' + shopName) : (d.note || ''),
          created_at: now_()
        };
      });
      const { error } = await supabase.from('transactions').insert(rows);
      if (error) throw error;
      return res.json({ ok: true, matchedShop: shopId ? { id: shopId, name: shopName } : null });
    }

    res.status(405).json({ ok: false, error: 'Method not allowed অথবা ভুল action' });
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
