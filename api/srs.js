const { supabase, cors, now_, mapSR, safeErr } = require('./_lib/db');
const { resolveThumb, deleteThumb } = require('./_lib/thumb');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

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

      // ══════════════════════════════════════════════════
      //  SO ↔ DSR DAILY PAIRING HANDSHAKE (AXIION §10 / §17)
      //  The permanent org-chart link stays so_id (set by Owner via
      //  assign_so below) — this is a lightweight session-level
      //  "connect" on top of it. An SO may only request pairing with a
      //  DSR already assigned to them.
      // ══════════════════════════════════════════════════
      if (action === 'pair_request') {
        const { soId, dsrId } = d;
        if (!soId || !dsrId) return res.json({ ok: false, error: 'soId ও dsrId প্রয়োজন' });
        const { data: dsr, error: fetchErr } = await supabase.from('srs').select('id,so_id').eq('id', dsrId).single();
        if (fetchErr) throw fetchErr;
        if (!dsr || String(dsr.so_id || '') !== String(soId))
          return res.json({ ok: false, error: 'এই DSR আপনার অধীনে নয়' });
        const { error } = await supabase.from('srs').update({ so_link_status: 'pending' }).eq('id', dsrId);
        if (error) throw error;
        return res.json({ ok: true });
      }

      if (action === 'pair_accept') {
        const { dsrId } = d;
        if (!dsrId) return res.json({ ok: false, error: 'dsrId প্রয়োজন' });
        const { error } = await supabase.from('srs').update({ so_link_status: 'accepted' }).eq('id', dsrId);
        if (error) throw error;
        return res.json({ ok: true });
      }

      if (action === 'pair_reject') {
        const { dsrId } = d;
        if (!dsrId) return res.json({ ok: false, error: 'dsrId প্রয়োজন' });
        const { error } = await supabase.from('srs').update({ so_link_status: 'none' }).eq('id', dsrId);
        if (error) throw error;
        return res.json({ ok: true });
      }

      // ── Normal DSR/SO creation — auto-assigns a stable, never-reused
      //    display number for the chosen role (AXIION §10) ──────────
      const role = d.role || 'dsr';
      const { data: dn, error: dnErr } = await supabase.rpc('next_sr_display_no', { p_role: role });
      if (dnErr) throw dnErr;

      const { data, error } = await supabase.from('srs').insert({
        name: String(d.name||'').trim(), phone: d.phone||'',
        area: d.area||'', role,
        thumb: await resolveThumb(d.thumb, ''),
        so_id: String(d.soId||''), so_name: String(d.soName||''),
        display_no: dn, so_link_status: 'none',
        created_at: now_()
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, id: data.id, displayNo: dn });
    }

    if (req.method === 'PUT') {
      const d = req.body;
      if (!d.id) return res.json({ ok: false, error: 'id প্রয়োজন' });

      // Assign or unassign a DSR to an SO (permanent org-chart link).
      // Changing the SO automatically clears any stale pairing handshake.
      if (d.action === 'assign_so') {
        const { error } = await supabase.from('srs').update({
          so_id:   String(d.soId   || ''),
          so_name: String(d.soName || ''),
          so_link_status: 'none'
        }).eq('id', d.id);
        if (error) throw error;
        return res.json({ ok: true });
      }

      const { data: ex } = await supabase.from('srs').select('thumb').eq('id',d.id).single();
      const thumb = await resolveThumb(d.thumb, ex ? ex.thumb||'' : '');
      // Name/meta edits never touch display_no or so_id — per §10, if the
      // person in a numbered slot changes, only name/phone/area/thumb
      // update; every historical record keeps pointing at the same
      // stable id/display_no.
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
      const { data: row } = await supabase.from('srs').select('thumb').eq('id', id).single();
      const { error } = await supabase.from('srs').delete().eq('id', id);
      if (error) throw error;
      if (row && row.thumb) deleteThumb(row.thumb);
      return res.json({ ok: true });
    }
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) { res.json({ ok: false, error: safeErr(e) }); }
};
