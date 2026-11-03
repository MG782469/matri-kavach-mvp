/* Session storage. Postgres when DATABASE_URL is set, otherwise memory (local tests, no setup). */
const clone = (x) => JSON.parse(JSON.stringify(x));

class MemoryStore {
  constructor() { this.m = new Map(); }
  async init() {}
  async get(id) { return this.m.has(id) ? clone(this.m.get(id)) : null; }
  async put(s) { this.m.set(s.id, clone(s)); }
  async active() {
    return [...this.m.values()].filter((s) => s.cur && (s.cur.state === 'sent' || s.cur.state === 'ivr')).map(clone);
  }
}

class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    const ssl = /\.render\.com|sslmode=require/.test(url) ? { rejectUnauthorized: false } : false;
    this.pool = new Pool({ connectionString: url, ssl, max: 5 });
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS sessions (
      id text PRIMARY KEY, data jsonb NOT NULL, state text, updated_at timestamptz NOT NULL DEFAULT now())`);
    await this.pool.query(`DELETE FROM sessions WHERE id NOT IN ('live', 'tg-contacts') AND updated_at < now() - interval '3 days'`);
  }
  async get(id) {
    const r = await this.pool.query('SELECT data FROM sessions WHERE id = $1', [id]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  async put(s) {
    await this.pool.query(
      `INSERT INTO sessions (id, data, state, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET data = $2, state = $3, updated_at = now()`,
      [s.id, JSON.stringify(s), s.cur ? s.cur.state : null]);
  }
  async active() {
    const r = await this.pool.query(`SELECT data FROM sessions WHERE state IN ('sent','ivr')`);
    return r.rows.map((x) => x.data);
  }
}

module.exports = function makeStore(url) { return url ? new PgStore(url) : new MemoryStore(); };
module.exports.MemoryStore = MemoryStore;
