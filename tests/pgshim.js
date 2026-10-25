// Minimal supabase-js look-alike over a real Postgres (tests only).
const { Pool } = require('pg');
class Q {
  constructor(pool, table) { this.pool = pool; this.t = table; this.op = 'select'; this.w = []; this.p = []; this.ord = []; this.cols = '*'; this.lim = null; this.off = 0; this.one = null; this.count = null; this.head = false; this.ret = false; }
  select(c, o) { if (this.op === 'select') this.cols = c || '*'; else this.ret = true; if (o && o.count) this.count = o.count; if (o && o.head) this.head = true; return this; }
  insert(v) { this.op = 'insert'; this.v = v; return this; }
  update(v) { this.op = 'update'; this.v = v; return this; }
  upsert(v) { this.op = 'upsert'; this.v = v; return this; }
  delete() { this.op = 'delete'; return this; }
  _add(sql, ...vals) { let s = sql; vals.forEach((v) => { this.p.push(v); s = s.replace('?', '$' + this.p.length); }); this.w.push(s); return this; }
  eq(c, v) { return this._add(`"${c}" = ?`, v); }
  gte(c, v) { return this._add(`"${c}" >= ?`, v); }
  lte(c, v) { return this._add(`"${c}" <= ?`, v); }
  not(c, op, v) { if (op === 'is' && v === null) return this._add(`"${c}" is not null`); throw new Error('shim not'); }
  or(expr) { const parts = expr.split(/,(?=\w+\.)/).map((x) => { const m = x.match(/^(\w+)\.ilike\.(.*)$/); this.p.push(m[2]); return `"${m[1]}" ilike $${this.p.length}`; }); this.w.push('(' + parts.join(' or ') + ')'); return this; }
  order(c, o) { this.ord.push(`"${c}" ${o && o.ascending === false ? 'desc' : 'asc'}`); return this; }
  limit(n) { this.lim = n; return this; }
  range(a, b) { this.off = a; this.lim = b - a + 1; return this; }
  single() { this.one = 'single'; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  async _run() {
    const where = this.w.length ? ' where ' + this.w.join(' and ') : '';
    let sql, rows, total = null;
    const w = (o) => o;
    if (this.op === 'select') {
      if (this.head) { const r = await this.pool.query(`select count(*)::int c from "${this.t}"${where}`, this.p); return { count: r.rows[0].c, data: null, error: null }; }
      sql = `select ${this.cols === '*' ? '*' : this.cols} from "${this.t}"${where}`;
      if (this.count) { const r = await this.pool.query(`select count(*)::int c from "${this.t}"${where}`, this.p); total = r.rows[0].c; }
      if (this.ord.length) sql += ' order by ' + this.ord.join(',');
      if (this.lim != null) sql += ` limit ${this.lim} offset ${this.off}`;
      rows = (await this.pool.query(sql, this.p)).rows;
    } else if (this.op === 'insert' || this.op === 'upsert') {
      const arr = Array.isArray(this.v) ? this.v : [this.v]; rows = [];
      for (const o of arr) {
        const ks = Object.keys(o), vals = ks.map((k) => ((o[k] !== null && typeof o[k] === 'object') || (this.t === 'settings' && k === 'value') ? JSON.stringify(o[k]) : o[k]));
        sql = `insert into "${this.t}"(${ks.map((k) => `"${k}"`).join(',')}) values(${ks.map((_, i) => '$' + (i + 1)).join(',')})`;
        if (this.op === 'upsert') { const pk = { settings: 'key', attendance: 'employee_id,date', day_close: 'date' }[this.t] || 'id'; sql += ` on conflict (${pk}) do update set ${ks.filter((k) => !pk.split(',').includes(k)).map((k) => `"${k}"=excluded."${k}"`).join(',')}`; }
        sql += ' returning *';
        rows.push(...(await this.pool.query(sql, vals)).rows);
      }
    } else if (this.op === 'update') {
      const ks = Object.keys(this.v); const base = this.p.length;
      const set = ks.map((k, i) => `"${k}"=$${base + i + 1}`).join(',');
      rows = (await this.pool.query(`update "${this.t}" set ${set}${where} returning *`, this.p.concat(ks.map((k) => this.v[k])))).rows;
    } else if (this.op === 'delete') {
      rows = (await this.pool.query(`delete from "${this.t}"${where} returning *`, this.p)).rows;
    }
    if (this.one) { if (rows.length > 1) return { data: null, error: { message: 'multiple rows' } }; if (!rows.length) return this.one === 'single' ? { data: null, error: { message: 'no rows' } } : { data: null, error: null }; return { data: rows[0], error: null, count: total }; }
    return { data: this.op === 'select' || this.ret ? rows : null, error: null, count: total };
  }
  then(res, rej) { return this._run().catch((e) => ({ data: null, error: { message: e.message } })).then(res, rej); }
}
function makeDb(conn) {
  const pool = new Pool(conn);
  pool.on('error', () => {});
  return {
    pool,
    from: (t) => new Q(pool, t),
    async rpc(name, args) {
      try {
        const keys = Object.keys(args || {});
        const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
        const typed = keys.map((k, i) => (typeof args[k] === 'object' && args[k] !== null ? `$${i + 1}::jsonb` : k.startsWith('p_date') || /^p_(from|to)$/.test(k) ? `$${i + 1}::date` : k === 'p_id' ? `$${i + 1}::uuid` : `$${i + 1}`));
        const r = await pool.query(`select ${name}(${keys.map((k, i) => `${k} => ${typed[i]}`).join(',')}) as r`, vals);
        return { data: r.rows[0].r, error: null };
      } catch (e) { return { data: null, error: { message: e.message } }; }
    }
  };
}
module.exports = { makeDb };
