const { supabase, cors, now_, mapSR, safeErr } = require('./_lib/db');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    if (req.method === 'GET') {
      const { soId } = req.query;
      let q = supabase.from('srs').select('*').order('created_at');
      // soId filter: returns only DSRs assigned to this SO
      if (soId) q = q.eq('so_id', soId);
      const { data, error } = await q;
      if (error) throw error;
      return res.json((data || []).map(mapSR));
    }
    if (req.method === 'POST') {
      const d = req.body;
      const { data, error } = await supabase.from('srs').insert({
        name: String(d.name||'').trim(), phone: d.phone||'',
        area: d.area||'', role: d.role||'dsr',
        thumb: String(d.thumb||''),
        so_id: String(d.soId||''), so_name: String(d.soName||''),
        created_at: now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, id: data.id });
    }
    if (req.method === 'PUT') {
      const d = req.body;
      if (!d.id) return res.json({ ok: false, error: 'id প্রয়োজন' });

      // Assign or unassign a DSR to an SO
      if (d.action === 'assign_so') {
        const { error } = await supabase.from('srs').update({
          so_id:   String(d.soId   || ''),
          so_name: String(d.soName || '')
        }).eq('id', d.id);
        if (error) throw error;
        return res.json({ ok: true });
      }

      let thumb = String(d.thumb||'');
      if (!thumb) {
        const { data: ex } = await supabase.from('srs').select('thumb').eq('id',d.id).single();
        if (ex) thumb = ex.thumb||'';
      }
      const { error } = await supabase.from('srs').update({
        name: String(d.name||'').trim(), phone: d.phone||'',
        area: d.area||'', role: d.role||'dsr', thumb,
        so_id: d.soId !== undefined ? String(d.soId||'') : undefined,
        so_name: d.soName !== undefined ? String(d.soName||'') : undefined
      }).eq('id', d.id);
      if (error) throw error;
      return res.json({ ok: true });
    }
    if (req.method === 'DELETE') {
      const id = req.body?.id || req.query?.id;
      if (!id) return res.json({ ok: false, error: 'id প্রয়োজন' });
      const { error } = await supabase.from('srs').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) { res.json({ ok: false, error: safeErr(e) }); }
};
