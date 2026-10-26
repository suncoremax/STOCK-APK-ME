// Expenses · important numbers · business settings · data reset  (one file = one serverless function)
//   GET  ?type=cats|expenses|contacts|settings
//   POST {type:'cat'|'expense'|'contact'|'settings'|'reset', ...}
//   DELETE ?type=cat|expense|contact&id=
const { supabase, cors, str, safeErr, num, today, fetchAll, mapExpCat, mapExpRecord, auditLog, idemRun } = require('./_lib/db');
const { requireAuth, needPin } = require('./_lib/auth');
const { r2 } = require('./_lib/money');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_CATS = ['গাড়ি ভাড়া', 'বেতন', 'অফিস খরচ', 'বিদ্যুৎ বিল', 'খাবার', 'অন্যান্য'];

// What Settings → "ডেটা রিসেট" can wipe (for clearing test entries before real use).
// Products, DSR/SO names, shops, contacts, expense categories and settings are NEVER touched.
const RESET = {
  transactions: { label: 'লেনদেন (দেওয়া, ফেরত, ড্যামেজ, কেনা, বিক্রয়) — স্টক ০ হবে', tables: ['transactions'] },
  slips:        { label: 'দিনশেষ স্লিপ ও DSR পেমেন্ট',                              tables: ['dayend_slips', 'sr_payments'] },
  dues:         { label: 'দোকানের বাকি ও আদায়',                                   tables: ['due_collections', 'due_calendar'] },
  claims:       { label: 'ড্যামেজ ক্লেইম ও বোনাস রেকর্ড',                            tables: ['dmg_claims', 'bonus'] },
  expenses:     { label: 'খরচের রেকর্ড',                                           tables: ['exp_records'] }
};
const settingsOut = (r) => ({ shopName: r.shop_name || '', shopAddress: r.shop_address || '', shopPhone: r.shop_phone || '', distributorName: r.distributor_name || '',
  logoText: r.logo_text || '', blockNegativeStock: r.block_negative_stock !== false });

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const q = req.query || {};
  try {
    if (req.method === 'GET') {
      const type = q.type || 'settings';
      if (type === 'settings') {
        const { data } = await supabase.from('app_settings').select('*').eq('id', 1).maybeSingle();
        return res.json({ ok: true, settings: settingsOut(data || {}), resetOptions: Object.keys(RESET).map(k => ({ key: k, label: RESET[k].label })) });
      }
      if (type === 'cats') {
        let { data } = await supabase.from('exp_cats').select('*').order('created_at');
        if (!data || !data.length) {   // first visit: give the owner the usual headings
          await supabase.from('exp_cats').insert(DEFAULT_CATS.map(name => ({ name })));
          ({ data } = await supabase.from('exp_cats').select('*').order('created_at'));
        }
        return res.json({ ok: true, cats: (data || []).map(mapExpCat) });
      }
      if (type === 'expenses') {
        const from = DATE_RE.test(q.from || '') ? q.from : null, to = DATE_RE.test(q.to || '') ? q.to : null;
        let qq = supabase.from('exp_records').select('*').order('date', { ascending: false }).order('created_at', { ascending: false }).limit(2000);
        if (from) qq = qq.gte('date', from); if (to) qq = qq.lte('date', to);
        const { data, error } = await qq; if (error) throw error;
        return res.json({ ok: true, expenses: (data || []).map(mapExpRecord) });
      }
      if (type === 'contacts') {
        const { data, error } = await supabase.from('important_contacts').select('*').order('name'); if (error) throw error;
        return res.json({ ok: true, contacts: (data || []).map(r => ({ id: String(r.id), name: r.name, role: r.role, phone: r.phone_number, note: r.special_note })) });
      }
      return res.json({ ok: false, error: 'Unknown type' });
    }

    if (req.method === 'POST') return idemRun(req, res, 'set', async () => {
      const d = req.body || {};
      if (d.type === 'cat') {
        const name = str(d.name, 60); if (!name) return res.json({ ok: false, error: 'নাম দিন' });
        const { data, error } = await supabase.from('exp_cats').insert({ name }).select().single(); if (error) throw error;
        return res.json({ ok: true, cat: mapExpCat(data) });
      }
      if (d.type === 'expense') {
        const amount = r2(num(d.amount)); if (amount <= 0) return res.json({ ok: false, error: 'টাকার পরিমাণ দিন' });
        const { data: cat } = await supabase.from('exp_cats').select('id,name').eq('id', String(d.categoryId || '')).maybeSingle();
        if (!cat) return res.json({ ok: false, error: 'খরচের খাত বেছে নিন' });
        const { data, error } = await supabase.from('exp_records').insert({ category_id: String(cat.id), category_name: cat.name, date: DATE_RE.test(d.date || '') ? d.date : today(), amount, note: str(d.note, 300) }).select().single();
        if (error) throw error;
        return res.json({ ok: true, expense: mapExpRecord(data) });
      }
      if (d.type === 'contact') {
        const name = str(d.name, 80); if (!name) return res.json({ ok: false, error: 'নাম দিন' });
        const row = { name, role: str(d.role, 60), phone_number: str(d.phone, 30), special_note: str(d.note, 300), created_by: 'owner' };
        const { data, error } = d.id ? await supabase.from('important_contacts').update(row).eq('id', String(d.id)).select().single() : await supabase.from('important_contacts').insert(row).select().single();
        if (error) throw error;
        return res.json({ ok: true, id: String(data.id) });
      }
      if (d.type === 'settings') {
        const row = { id: 1, updated_at: new Date().toISOString(), set_by: 'owner' };
        if (d.shopName !== undefined) row.shop_name = str(d.shopName, 100);
        if (d.shopAddress !== undefined) row.shop_address = str(d.shopAddress, 200);
        if (d.shopPhone !== undefined) row.shop_phone = str(d.shopPhone, 40);
        if (d.distributorName !== undefined) row.distributor_name = str(d.distributorName, 100);
        if (d.logoText !== undefined) row.logo_text = str(d.logoText, 60);
        if (d.blockNegativeStock !== undefined) row.block_negative_stock = !!d.blockNegativeStock;
        const { data, error } = await supabase.from('app_settings').upsert(row).select().single(); if (error) throw error;
        return res.json({ ok: true, settings: settingsOut(data) });
      }
      if (d.type === 'reset') {
        if (!(await needPin(req, res, d.pin))) return;
        const keys = (Array.isArray(d.what) ? d.what : []).filter(k => RESET[k]);
        if (!keys.length) return res.json({ ok: false, error: 'কী মুছবেন বেছে নিন' });
        if (keys.includes('transactions') && !keys.includes('slips'))   // slips point at transactions — never leave them dangling
          return res.json({ ok: false, error: 'লেনদেন মুছলে "দিনশেষ স্লিপ ও পেমেন্ট"-ও মুছতে হবে, নইলে হিসাব মিলবে না' });
        for (const k of keys) for (const t of RESET[k].tables) {
          const { error } = await supabase.from(t).delete().not('id', 'is', null); if (error) throw error;
        }
        if (keys.includes('transactions')) await supabase.from('products').update({ current_stock: 0 }).not('id', 'is', null);
        await auditLog({ id: 'owner', role: 'owner' }, 'reset', 'all', '', null, { keys });
        return res.json({ ok: true, wiped: keys });
      }
      return res.json({ ok: false, error: 'Unknown type' });
    });

    if (req.method === 'DELETE') {
      const id = String(q.id || '');
      if (q.type === 'cat') {
        const { count } = await supabase.from('exp_records').select('id', { count: 'exact', head: true }).eq('category_id', id);
        if (count) return res.json({ ok: false, error: 'এই খাতে খরচ লেখা আছে — মোছা যাবে না' });
        const { error } = await supabase.from('exp_cats').delete().eq('id', id); if (error) throw error; return res.json({ ok: true });
      }
      if (q.type === 'expense') { const { error } = await supabase.from('exp_records').delete().eq('id', id); if (error) throw error; return res.json({ ok: true }); }
      if (q.type === 'contact') { const { error } = await supabase.from('important_contacts').delete().eq('id', id); if (error) throw error; return res.json({ ok: true }); }
      return res.json({ ok: false, error: 'Unknown type' });
    }
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) { res.json({ ok: false, error: safeErr(e) }); }
};
