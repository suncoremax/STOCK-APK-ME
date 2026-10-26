// DSR / SO = names only. Nobody logs in with these; the owner picks them when giving stock or entering a slip.
const { supabase, cors, str, safeErr, mapSR, getDueTotals, num, auditLog } = require('./_lib/db');
const { requireAuth, needPin } = require('./_lib/auth');
const { r2 } = require('./_lib/money');
const OWNER = { id: 'owner', role: 'owner' };

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase.from('srs').select('*').order('role').order('display_no');
      if (error) throw error;
      const list = (data || []).map(mapSR);
      const dues = await getDueTotals(list.map(s => s.id));
      list.forEach(s => {
        const o = dues[s.id] || { givenRev: 0, returnRev: 0, payments: 0 };
        s.due = r2(o.givenRev - o.returnRev - o.payments);
        s.givenRev = r2(o.givenRev); s.returnRev = r2(o.returnRev); s.paid = r2(o.payments);
      });
      return res.json({ ok: true, srs: list });
    }
    if (req.method === 'POST') {
      const d = req.body || {};
      const name = str(d.name, 80);
      const role = d.role === 'so' ? 'so' : 'dsr';
      if (!name) return res.json({ ok: false, error: 'নাম দিন' });
      const { data: dup } = await supabase.from('srs').select('id').eq('role', role).ilike('name', name).limit(1);
      if (dup && dup.length) return res.json({ ok: false, error: 'এই নামে ' + role.toUpperCase() + ' আগেই আছে' });
      const { data: no, error: e1 } = await supabase.rpc('next_sr_display_no', { p_role: role });
      if (e1) throw e1;
      const { data, error } = await supabase.from('srs').insert({ name, role, phone: str(d.phone, 30), area: str(d.area, 120), display_no: Number(no) }).select().single();
      if (error) throw error;
      await auditLog(OWNER, 'create', 'srs', data.id, null, data);
      return res.json({ ok: true, sr: mapSR(data) });
    }
    if (req.method === 'PUT') {
      const d = req.body || {};
      const id = String(req.query.id || d.id || '');
      const patch = {};
      if (d.name !== undefined) { patch.name = str(d.name, 80); if (!patch.name) return res.json({ ok: false, error: 'নাম দিন' }); }
      if (d.phone !== undefined) patch.phone = str(d.phone, 30);
      if (d.area !== undefined) patch.area = str(d.area, 120);
      const { data, error } = await supabase.from('srs').update(patch).eq('id', id).select().single();
      if (error) throw error;
      if (patch.name) {   // keep the name printed on old records in step
        await supabase.from('transactions').update({ sr_name: patch.name }).eq('sr_id', id);
        await supabase.from('sr_payments').update({ sr_name: patch.name }).eq('sr_id', id);
        await supabase.from('dayend_slips').update({ dsr_name: patch.name }).eq('dsr_id', id);
        await supabase.from('shops').update({ assigned_dsr_name: patch.name }).eq('assigned_dsr_id', id);
      }
      return res.json({ ok: true, sr: mapSR(data) });
    }
    if (req.method === 'DELETE') {
      const id = String(req.query.id || '');
      if (!(await needPin(req, res, req.query.pin))) return;
      const [a, b] = await Promise.all([
        supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('sr_id', id),
        supabase.from('sr_payments').select('id', { count: 'exact', head: true }).eq('sr_id', id)
      ]);
      if ((a.count || 0) + (b.count || 0) > 0) return res.json({ ok: false, error: 'এর লেনদেনের হিসাব আছে — মুছে ফেলা যাবে না' });
      await supabase.from('shops').update({ assigned_dsr_id: '', assigned_dsr_name: '' }).eq('assigned_dsr_id', id);
      const { error } = await supabase.from('srs').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) { res.json({ ok: false, error: safeErr(e) }); }
};
