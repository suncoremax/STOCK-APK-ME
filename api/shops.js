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
  mapShop, mapDue, mapTx, fetchAll, mapShopVisit, mapPosCustomer, bdtToday
} = require('./_lib/db');

// V48 update #37/#38 — re-verifies an Owner PIN server-side (never trust
// a client-side role flag alone). Same table/pattern already used by
// api/attendance.js/_verifyOwnerPin, api/sr-payments.js action=
// approval_edit, and api/report.js action=daily-generate.
async function _verifyOwnerPin(pin) {
  const p = String(pin || '').trim();
  if (!/^\d{5}$/.test(p)) return false;
  const { data } = await supabase.from('user_passwords').select('id').eq('role', 'owner').eq('password', p).limit(1);
  return !!(data && data.length);
}

// V48 update #38 — blocks registering/renaming a shop to the exact same
// name (trimmed, case-insensitive) as an existing shop, so the owner is
// forced to add a distinguishing number/suffix instead of silently
// getting an identical duplicate. `excludeId` lets the edit action check
// against every OTHER shop without tripping on the shop's own row.
async function _isDuplicateShopName(name, excludeId) {
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return false;
  const { data, error } = await supabase.from('shops').select('id,name');
  if (error) throw error;
  return (data || []).some(s => String(s.id) !== String(excludeId || '') && String(s.name || '').trim().toLowerCase() === needle);
}

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

      // Update #38 — block an exact-name duplicate; ask for a
      // distinguishing number/suffix instead of a silent identical row.
      if (await _isDuplicateShopName(d.name)) {
        return res.json({ ok: false, error: 'এই নামে ইতিমধ্যে একটি শপ নিবন্ধিত আছে — আলাদা করতে নামের সাথে একটি নম্বর/সংযোজন যোগ করুন (যেমন: "মা স্টোর ২")' });
      }

      // ══════════════════════════════════════════════════
      //  ROAD → AUTO-FILL SO/DSR (Update #23)
      //  Registering a shop now picks a Road; that road's currently
      //  assigned DSR (Update #22) is derived automatically — assignedDsrId
      //  is no longer chosen by hand once a road is picked. A bare
      //  assignedDsrId with no roadId is still accepted for backward
      //  compatibility (older clients / one-off shops with no road).
      // ══════════════════════════════════════════════════
      let assignedDsrId = d.assignedDsrId ? String(d.assignedDsrId) : '';
      let assignedDsrName = '';
      let roadId = '', roadName = '';
      if (d.roadId) {
        const { data: road, error: roadErr } = await supabase.from('roads').select('*').eq('id', d.roadId).single();
        if (roadErr || !road) return res.json({ ok: false, error: 'রোড পাওয়া যায়নি' });
        if (!road.dsr_id) return res.json({ ok: false, error: 'এই রোডে এখনো DSR নেই — আগে SO নিয়োগ করুন' });
        roadId = String(road.id); roadName = road.name || '';
        assignedDsrId = road.dsr_id; assignedDsrName = road.dsr_name || '';
      } else {
        if (!assignedDsrId) return res.json({ ok: false, error: 'রোড অথবা DSR নির্বাচন আবশ্যক' });
        const { data: dsr } = await supabase.from('srs').select('name').eq('id', assignedDsrId).single();
        assignedDsrName = dsr ? dsr.name : '';
      }

      const { data: seq, error: seqErr } = await supabase.rpc('next_shop_no');
      if (seqErr) throw seqErr;
      const shopNo = 'SHOP-' + String(seq).padStart(4, '0');

      const { data, error } = await supabase.from('shops').insert({
        id:               randomUUID(),
        shop_no:          shopNo,
        name:             str(d.name, 200),
        keeper_name:      str(d.keeperName, 200),
        phone:            str(d.phone, 30),
        address:          str(d.address, 300),
        lat:              d.lat != null ? num(d.lat) : null,
        lng:              d.lng != null ? num(d.lng) : null,
        assigned_dsr_id:  assignedDsrId,
        assigned_dsr_name: assignedDsrName,
        road_id:          roadId,
        road_name:        roadName,
        created_at:       now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, shop: mapShop(data) });
    }

    // ══════════════════════════════════════════════════
    //  EDIT — Owner-only. Name + phone number only (Update #37).
    //  GPS location stays locked once captured — if a shop truly needs
    //  to move, the owner deletes it and re-registers on the spot so the
    //  new GPS point is captured fresh, rather than letting a stale
    //  coordinate be hand-typed here.
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'edit') {
      const d = req.body || {};
      if (!d.shopId) return res.json({ ok: false, error: 'shopId প্রয়োজন' });
      if (!(await _verifyOwnerPin(d.ownerPin))) return res.json({ ok: false, error: 'ভুল Owner PIN' });

      const name = String(d.name || '').trim();
      if (!name) return res.json({ ok: false, error: 'দোকানের নাম আবশ্যক' });
      if (await _isDuplicateShopName(name, d.shopId)) {
        return res.json({ ok: false, error: 'এই নামে ইতিমধ্যে অন্য একটি শপ আছে — আলাদা করতে নামের সাথে একটি নম্বর/সংযোজন যোগ করুন' });
      }

      const { data, error } = await supabase.from('shops')
        .update({ name: str(name, 200), phone: str(d.phone, 30) })
        .eq('id', d.shopId).select().single();
      if (error) throw error;
      if (!data) return res.json({ ok: false, error: 'দোকান পাওয়া যায়নি' });
      return res.json({ ok: true, shop: mapShop(data) });
    }

    // ══════════════════════════════════════════════════
    //  DELETE — Owner-only (Update #37). Removes the shop row; since
    //  every map/list view is re-fetched from `list`/`search` above, the
    //  deleted shop's marker simply stops appearing — no separate
    //  "remove marker" step needed. Due/sales history rows are left
    //  intact for bookkeeping continuity; they just lose a live shop to
    //  point back to.
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'delete') {
      const d = req.body || {};
      if (!d.shopId) return res.json({ ok: false, error: 'shopId প্রয়োজন' });
      if (!(await _verifyOwnerPin(d.ownerPin))) return res.json({ ok: false, error: 'ভুল Owner PIN' });

      const { error } = await supabase.from('shops').delete().eq('id', d.shopId);
      if (error) throw error;
      return res.json({ ok: true });
    }

    // ══════════════════════════════════════════════════
    //  LIST / SEARCH — by number, name, DSR, or GPS proximity
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && (action === 'list' || action === 'search')) {
      const { q, dsrId, roadId, lat, lng, limit } = req.query;
      let query = supabase.from('shops').select('*').order('created_at', { ascending: false });
      if (dsrId) query = query.eq('assigned_dsr_id', dsrId);
      if (roadId) query = query.eq('road_id', roadId);
      const { data, error } = await query;
      if (error) throw error;
      let shops = (data || []).map(mapShop);

      // Attach each shop's outstanding due total (§11/§20 — "see due status")
      if (shops.length) {
        const ids = shops.map(s => s.id);
        const { data: dueRows, error: dueErr } = await supabase
          .from('due_calendar').select('shop_id,amount,paid_amount,status')
          .in('shop_id', ids).neq('status', 'cleared');
        if (dueErr) throw dueErr;
        const dueMap = {};
        (dueRows || []).forEach(r => {
          const sid = String(r.shop_id || '');
          dueMap[sid] = (dueMap[sid] || 0) + (num(r.amount) - num(r.paid_amount));
        });
        shops = shops.map(s => ({ ...s, totalDue: dueMap[s.id] || 0 }));
      }

      if (q) {
        const needle = String(q).trim().toLowerCase();
        shops = shops.filter(s =>
          s.shopNo.toLowerCase().includes(needle) ||
          s.name.toLowerCase().includes(needle) ||
          s.keeperName.toLowerCase().includes(needle) ||
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

      const [dueRes, txRows] = await Promise.all([
        supabase.from('due_calendar').select('*').eq('shop_id', shopId).order('due_date', { ascending: false }),
        fetchAll(() => supabase.from('transactions').select('*').eq('shop_id', shopId).order('created_at', { ascending: false }))
      ]);
      const dues  = (dueRes.data || []).map(mapDue);
      const sales = (txRows || []).map(mapTx);
      const totalDue = dues.filter(d => d.status !== 'cleared').reduce((s, d) => s + (num(d.amount) - num(d.paidAmount)), 0);

      return res.json({ ok: true, shop: mapShop(shopRow), dues, sales, totalDue });
    }

    // ══════════════════════════════════════════════════
    //  VISIT-SALE — DSR sells to a shop: due reminder already shown
    //  client-side from `detail`; this records the sale + payment split
    //
    //  LOGIC FIX (V31): this sale is made from stock the DSR ALREADY
    //  physically took from the warehouse (a 'give' transaction already
    //  deducted it from company stock, and already registered the full
    //  value against the DSR's own due at that moment). So this row must
    //  NOT touch stock again — it is recorded as its own type ('dsr_sale')
    //  which calcStock() deliberately does not subtract, unlike
    //  'point_sale' (a true walk-in/counter sale straight out of the
    //  warehouse, which correctly still deducts stock). It also must NOT
    //  reduce the DSR's own due — per business rule, the DSR's due only
    //  goes down when he actually hands over cash (sr_payments) or
    //  physically returns unsold stock ('return'); a credit sale to a shop
    //  just moves the "who owes it" bookkeeping into due_calendar
    //  (client_type='shop') for visibility, while the amount stays under
    //  the DSR's name until collected/handed over.
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
          tx_id: txId, type: 'dsr_sale',
          sr_id: String(d.dsrId), sr_name: d.dsrName || '',
          date, slip_no: d.slipNo || '',
          product_id: String(item.productId || ''), product_name: String(item.productName || ''),
          sku: String(item.sku || ''), cases: num(item.cases), pcs: num(item.pcs),
          total_units: u, purchase_price: pp, selling_price: sp,
          total_cost: u * pp, total_revenue: u * sp,
          // V35 — persist this item's own commission/discount (per-case
          // rate × cases sold, computed client-side) so the DSR Payment
          // page can total "today's commission" / "today's discount"
          // straight from the DB.
          commission_amt: num(item.commission) || 0,
          discount_amt: num(item.discount) || 0,
          shop_id: String(d.shopId), note: d.note || '',
          created_at: now_()
        };
      });
      // The bill's grand totals (d.commissionAmt / d.discountAmt) also
      // include any flat invoice-level discount that isn't tied to a
      // single product line (see _dsrSaleComputeBill's invoiceDiscount).
      // Reconcile any gap onto the first row so the sum of commission_amt
      // / discount_amt across this sale's rows always matches the exact
      // amounts shown on the DSR's bill/slip and used to compute payable.
      if (rows.length) {
        const itemCommSum = rows.reduce((s, r) => s + num(r.commission_amt), 0);
        const itemDiscSum = rows.reduce((s, r) => s + num(r.discount_amt), 0);
        const extraComm = +(num(d.commissionAmt || 0) - itemCommSum).toFixed(4);
        const extraDisc = +(num(d.discountAmt || 0) - itemDiscSum).toFixed(4);
        rows[0].commission_amt = +(num(rows[0].commission_amt) + extraComm).toFixed(4);
        rows[0].discount_amt   = +(num(rows[0].discount_amt) + extraDisc).toFixed(4);
      }
      const { error: txErr } = await supabase.from('transactions').insert(rows);
      if (txErr) throw txErr;

      const payable  = rows.reduce((s, r) => s + num(r.total_revenue), 0) - num(d.discountAmt || 0) - num(d.commissionAmt || 0);
      const paidNow  = num(d.paidAmount);
      const shortfall = +(payable - paidNow).toFixed(4);

      // §12 — every shop visit leaves a due_calendar trace: a shortfall
      // opens a pending entry that feeds the DSR's Clear Plate; a fully
      // paid visit still writes an already-cleared row so the shop's due
      // history (§11 detail view) shows a complete, honest audit trail
      // of every visit — not just the ones still owed.
      let due = null;
      if (payable > 0) {
        const { data: shopRow } = await supabase.from('shops').select('name').eq('id', d.shopId).single();
        const isCleared = shortfall <= 0;
        const { data: dueRow, error: dueErr } = await supabase.from('due_calendar').insert({
          id: randomUUID(), dsr_id: String(d.dsrId), dsr_name: d.dsrName || '',
          client_type: 'shop', shop_id: String(d.shopId), shop_name: shopRow ? shopRow.name : '',
          due_date: date, amount: payable, paid_amount: isCleared ? payable : Math.max(0, paidNow),
          note: 'দোকান বিক্রয়' + (isCleared ? ' (সম্পূর্ণ পরিশোধিত)' : ' বাকি'),
          status: isCleared ? 'cleared' : 'pending',
          cleared_date: isCleared ? date : null,
          created_at: now_()
        }).select().single();
        if (dueErr) throw dueErr;
        due = mapDue(dueRow);
      }

      // Map — Daily Visit Tracking (Update #26): every real shop sale
      // IS a DSR visit, so log it automatically — no separate tap needed
      // on the DSR side. Best-effort: never fail the sale over this.
      try {
        await supabase.from('shop_visits').insert({
          shop_id: String(d.shopId), visit_role: 'dsr',
          visitor_id: String(d.dsrId), visitor_name: d.dsrName || '',
          visit_date: date, created_at: now_()
        });
      } catch (ve) { /* non-fatal */ }

      return res.json({ ok: true, payable, paidNow, shortfall: Math.max(0, shortfall), due });
    }

    // ══════════════════════════════════════════════════
    //  MAP — DAILY VISIT TRACKING (Update #26)
    //  visit-log: the SO taps "visited" on a shop from their road view
    //  (SOs don't carry stock, so there's no sale to auto-log from).
    //  visit-log-list: today's ticks for the map — colour-coded so/dsr.
    //  No cleanup job needed for the "auto-reset at midnight" rule: every
    //  read below is filtered to a single calendar date, so yesterday's
    //  ticks simply stop matching once the date rolls over on its own.
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'visit-log') {
      const d = req.body;
      if (!d.shopId || !d.role) return res.json({ ok: false, error: 'shopId ও role প্রয়োজন' });
      if (d.role !== 'so' && d.role !== 'dsr') return res.json({ ok: false, error: 'role শুধু so অথবা dsr হতে পারে' });
      const date = d.date || bdtToday();
      const { data, error } = await supabase.from('shop_visits').insert({
        shop_id: String(d.shopId), visit_role: d.role,
        visitor_id: String(d.visitorId || ''), visitor_name: d.visitorName || '',
        visit_date: date, created_at: now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, visit: mapShopVisit(data) });
    }

    if (req.method === 'GET' && action === 'visit-log-list') {
      const { date, roadId } = req.query;
      const d = date || bdtToday();
      let shopIds = null;
      if (roadId) {
        const { data: roadShops, error: rsErr } = await supabase.from('shops').select('id').eq('road_id', roadId);
        if (rsErr) throw rsErr;
        shopIds = (roadShops || []).map(s => s.id);
        if (!shopIds.length) return res.json({ ok: true, visits: [] });
      }
      let q = supabase.from('shop_visits').select('*').eq('visit_date', d);
      if (shopIds) q = q.in('shop_id', shopIds);
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ ok: true, visits: (data || []).map(mapShopVisit) });
    }

    // ══════════════════════════════════════════════════
    //  CLEAR-PLATE — today's outstanding shop dues for one DSR
    //  (AXIION §12 — the "Clear Plate" system)
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'clear-plate') {
      const { dsrId } = req.query;
      if (!dsrId) return res.json({ ok: false, error: 'dsrId প্রয়োজন' });
      // §12 (merged শপ ডেলিভারি) — the plate is a rolling 12-hour window
      // from when each due was created, NOT the calendar day. This way a
      // DSR who visits shops across midnight (or just runs long) doesn't
      // lose or duplicate entries at the day boundary, and the entry
      // simply disappears from THIS list on its own 12h later — the
      // underlying due_calendar row is never deleted, only this view.
      const windowStart = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase.from('due_calendar')
        .select('*')
        .eq('client_type', 'shop').eq('dsr_id', dsrId)
        .gte('created_at', windowStart)
        .in('status', ['pending', 'partial'])
        .order('created_at');
      if (error) throw error;
      let plate = (data || []).map(mapDue);

      // Attach each shop's phone number so the DSR can tap-to-call
      // straight from the plate before/while collecting (§20 spirit).
      if (plate.length) {
        const shopIds = [...new Set(plate.map(p => p.shopId).filter(Boolean))];
        if (shopIds.length) {
          const { data: shopRows, error: shopErr } = await supabase
            .from('shops').select('id,phone').in('id', shopIds);
          if (shopErr) throw shopErr;
          const phoneMap = {};
          (shopRows || []).forEach(s => { phoneMap[String(s.id)] = s.phone || ''; });
          plate = plate.map(p => ({ ...p, shopPhone: phoneMap[p.shopId] || '' }));
        }
      }

      const totalAmount = plate.reduce((s, p) => s + (num(p.amount) - num(p.paidAmount)), 0);
      return res.json({ ok: true, plate, totalAmount, shopCount: plate.length });
    }

    // ══════════════════════════════════════════════════
    //  CLEAR-PLATE-ALL — company-wide today's outstanding shop dues,
    //  grouped by DSR (Owner/Manager overview of the §12 Clear Plate)
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'clear-plate-all') {
      // Same rolling 12-hour window as the per-DSR plate above, kept
      // consistent so the Owner/Manager overview always matches what
      // each DSR currently sees on their own plate.
      const windowStart = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase.from('due_calendar')
        .select('*')
        .eq('client_type', 'shop')
        .gte('created_at', windowStart)
        .in('status', ['pending', 'partial'])
        .order('dsr_name');
      if (error) throw error;
      const rows = (data || []).map(mapDue);

      const byDsr = {};
      rows.forEach(r => {
        const key = r.dsrId || '—';
        if (!byDsr[key]) byDsr[key] = { dsrId: r.dsrId, dsrName: r.dsrName || 'অজানা', shopCount: 0, totalAmount: 0, items: [] };
        const rem = num(r.amount) - num(r.paidAmount);
        byDsr[key].shopCount += 1;
        byDsr[key].totalAmount += rem;
        byDsr[key].items.push(r);
      });
      const dsrs = Object.values(byDsr).sort((a, b) => b.totalAmount - a.totalAmount);
      const totalAmount = dsrs.reduce((s, x) => s + x.totalAmount, 0);
      const shopCount   = dsrs.reduce((s, x) => s + x.shopCount, 0);
      return res.json({ ok: true, dsrs, totalAmount, shopCount });
    }

    // ══════════════════════════════════════════════════
    //  Update #52 — POINT-SALE CUSTOMER SEARCH
    //  GET /api/shops?action=pos-customer-search&q=<text>
    //  Searches both registered shops (§11) and pos_customers (§51) by
    //  name/phone, merged into one result list, so a repeat point-sale
    //  customer (sale OR damage/return, per Update #53) can be found and
    //  auto-filled instead of retyping their details every visit. Each
    //  result carries shopId or customerId (never both) so the caller
    //  can pass the right hint straight back into pos-customer-save.
    // ══════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'pos-customer-search') {
      const q = str(req.query.q, 100).trim();
      if (q.length < 2) return res.json({ ok: true, results: [] });
      const like = '%' + q.replace(/[%_,()]/g, ' ').trim() + '%';

      const [{ data: shopRows, error: shopErr }, { data: custRows, error: custErr }] = await Promise.all([
        supabase.from('shops').select('id,name,keeper_name,phone,address')
          .or(`name.ilike.${like},phone.ilike.${like}`).limit(10),
        supabase.from('pos_customers').select('id,name,keeper_name,phone,address')
          .or(`name.ilike.${like},phone.ilike.${like}`).limit(10)
      ]);
      if (shopErr) throw shopErr;
      if (custErr) throw custErr;

      const results = [
        ...(shopRows || []).map(r => ({
          source: 'shop', shopId: String(r.id), customerId: '',
          name: r.name || '', keeperName: r.keeper_name || '', phone: r.phone || '', address: r.address || ''
        })),
        ...(custRows || []).map(r => ({
          source: 'customer', shopId: '', customerId: String(r.id),
          name: r.name || '', keeperName: r.keeper_name || '', phone: r.phone || '', address: r.address || ''
        }))
      ].slice(0, 15);

      return res.json({ ok: true, results });
    }

    // ══════════════════════════════════════════════════
    //  Update #51 — POINT-SALE CUSTOMER CAPTURE
    //  Full customer details (shop name, phone, address, keeper name —
    //  the same basic fields as normal shop registration), stored as a
    //  proper record instead of a bare free-text name. Called by the
    //  Point-Sale wizard right before the actual sale transaction is
    //  saved; returns whichever id (an existing registered shop, or a
    //  pos_customers record) the transaction should be tagged with.
    //  Update #53 — the same endpoint is now also called by the
    //  point-sale damage/return sub-flow, so those rows get a real
    //  shop_id/customer_id too instead of only a free-text name.
    // ══════════════════════════════════════════════════
    if (req.method === 'POST' && action === 'pos-customer-save') {
      const d = req.body;
      const name = str(d.name, 200);
      if (!name) return res.json({ ok: false, error: 'কাস্টমারের/দোকানের নাম আবশ্যক' });
      const phone      = str(d.phone, 30);
      const address    = str(d.address, 300);
      const keeperName = str(d.keeperName, 200);

      // Update #52 — if the customer was picked from the search
      // dropdown, reuse that exact record instead of re-matching by
      // phone, so editing a phone-less repeat customer's details on a
      // later visit updates the same row instead of creating a
      // duplicate.
      const selShopId = str(d.selectedShopId, 60);
      const selCustId = str(d.selectedCustomerId, 60);
      if (selShopId) {
        const { data: shopRow, error: shopErr } = await supabase.from('shops').select('id,name').eq('id', selShopId).limit(1);
        if (shopErr) throw shopErr;
        if (shopRow && shopRow.length) return res.json({ ok: true, shopId: shopRow[0].id, shopName: shopRow[0].name, customerId: '' });
      }
      if (selCustId) {
        const { data: custRow, error: updErr } = await supabase.from('pos_customers').update({
          name, keeper_name: keeperName, phone, address
        }).eq('id', selCustId).select('id').limit(1);
        if (updErr) throw updErr;
        if (custRow && custRow.length) return res.json({ ok: true, shopId: '', customerId: custRow[0].id, customerName: name });
      }

      // 1) A phone that matches an existing REGISTERED SHOP wins first —
      //    reuse that shop's real record/history instead of creating a
      //    parallel customer record for the same real-world shop.
      if (phone) {
        const { data: shopMatch } = await supabase.from('shops').select('id,name').eq('phone', phone).limit(1);
        if (shopMatch && shopMatch.length) {
          return res.json({ ok: true, shopId: shopMatch[0].id, shopName: shopMatch[0].name, customerId: '' });
        }
      }

      // 2) A phone that matches an existing pos_customers record →
      //    update it in place (repeat walk-in customer) instead of
      //    growing a duplicate row every visit.
      if (phone) {
        const { data: custMatch } = await supabase.from('pos_customers').select('id').eq('phone', phone).limit(1);
        if (custMatch && custMatch.length) {
          const { error: updErr } = await supabase.from('pos_customers').update({
            name, keeper_name: keeperName, address
          }).eq('id', custMatch[0].id);
          if (updErr) throw updErr;
          return res.json({ ok: true, shopId: '', customerId: custMatch[0].id, customerName: name });
        }
      }

      // 3) No match (or no phone at all) → brand-new customer record.
      const { data: inserted, error: insErr } = await supabase.from('pos_customers').insert({
        name, keeper_name: keeperName, phone, address
      }).select('id').single();
      if (insErr) throw insErr;
      return res.json({ ok: true, shopId: '', customerId: inserted.id, customerName: name });
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
