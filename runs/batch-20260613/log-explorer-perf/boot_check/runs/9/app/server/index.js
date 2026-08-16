import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_DIR = path.join(__dirname, '..', 'pglite-data');
fs.mkdirSync(DB_DIR, { recursive: true });

const PORT = process.env.PORT || 3000;
const ROWS = 100000;
const BATCH = 5000;
const severities = ['debug', 'info', 'warn', 'error'];
const services = ['auth', 'payments', 'orders', 'inventory', 'search', 'mailer', 'gateway', 'analytics'];
const templates = [
  'request completed for user {user} route {route} trace {trace}',
  'cache hit key {key} latency {latency}ms shard {shard}',
  'cache miss key {key} rebuilt in {latency}ms shard {shard}',
  'database query completed table {table} duration {latency}ms rows {rows}',
  'retry scheduled for job {job} attempt {attempt} reason timeout',
  'validation failed field {field} user {user} code {code}',
  'downstream response received partner {partner} status {status} duration {latency}ms',
  'background job {job} finished batch {batch} processed {rows}',
  'rate limit checked subject {user} bucket {bucket} allowed true',
  'security audit event {event} actor {user} trace {trace}',
  'payment declined card token {token} reason insufficient_funds',
  'index refresh segment {segment} documents {rows} duration {latency}ms'
];

const db = new PGlite(DB_DIR);

function severityFor(i) {
  const x = (i * 37) % 100;
  if (x < 60) return 'debug';
  if (x < 85) return 'info';
  if (x < 95) return 'warn';
  return 'error';
}
function esc(s) { return String(s).replace(/'/g, "''"); }
function msgFor(i, service, sev) {
  const tpl = templates[(i * 17 + service.length) % templates.length];
  const route = ['/api/login','/api/orders','/api/search','/api/cart','/api/checkout','/internal/health'][i % 6];
  return tpl
    .replaceAll('{user}', `user-${(i * 13) % 25000}`)
    .replaceAll('{route}', route)
    .replaceAll('{trace}', `tr-${(i * 2654435761 >>> 0).toString(16).padStart(8,'0')}`)
    .replaceAll('{key}', `key-${(i * 19) % 6000}`)
    .replaceAll('{latency}', String((i * 7) % 997))
    .replaceAll('{shard}', String(i % 32))
    .replaceAll('{table}', ['users','orders','sessions','ledger','products'][i % 5])
    .replaceAll('{rows}', String(1 + ((i * 23) % 5000)))
    .replaceAll('{job}', ['email-digest','invoice-sync','fraud-scan','reconcile','webhook'][i % 5])
    .replaceAll('{attempt}', String(1 + (i % 5)))
    .replaceAll('{field}', ['email','address','quantity','sku','password'][i % 5])
    .replaceAll('{code}', `E${1000 + (i % 900)}`)
    .replaceAll('{partner}', ['stripe','sendgrid','maps','tax','warehouse'][i % 5])
    .replaceAll('{status}', String([200,201,204,400,404,429,500,503][i % 8]))
    .replaceAll('{batch}', String(i % 1000))
    .replaceAll('{bucket}', ['login','checkout','search','write','read'][i % 5])
    .replaceAll('{event}', ['login','logout','token-refresh','permission-check','password-reset'][i % 5])
    .replaceAll('{token}', `tok_${(i * 31) % 100000}`)
    .replaceAll('{segment}', `seg-${i % 128}`) + ` service ${service} level ${sev}`;
}

async function init() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL,
      message_lc TEXT NOT NULL
    );
  `);
  const countRes = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const count = Number(countRes.rows[0]?.count || 0);
  if (count !== ROWS) {
    if (count > 0) await db.query('TRUNCATE logs');
    console.log(`Seeding ${ROWS} deterministic log rows...`);
    const start = Date.UTC(2024, 0, 1, 0, 0, 0);
    const span = 30 * 24 * 60 * 60 * 1000;
    for (let base = 0; base < ROWS; base += BATCH) {
      const vals = [];
      const end = Math.min(ROWS, base + BATCH);
      for (let i = base; i < end; i++) {
        const id = i + 1;
        // Strictly increasing deterministic timestamps across 30 days.
        const ts = new Date(start + Math.floor((i / ROWS) * span)).toISOString();
        const sev = severityFor(i);
        const svc = services[(i * 11) % services.length];
        const msg = msgFor(i, svc, sev);
        vals.push(`(${id},'${ts}','${sev}','${svc}','${esc(msg)}','${esc(msg.toLowerCase())}')`);
      }
      await db.query(`INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${vals.join(',')}`);
      if ((base / BATCH) % 4 === 0) console.log(`seeded ${end}/${ROWS}`);
    }
    console.log('Seeding complete');
  } else {
    console.log(`Seed already present (${count} rows)`);
  }
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_message_lc ON logs (message_lc)');
  // Keep planner statistics current for the seeded corpus.
  await db.query('ANALYZE logs');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function parseLogsParams(req, res) {
  const rawOffset = req.query.offset ?? '0';
  const rawLimit = req.query.limit ?? '100';
  if (!/^\d+$/.test(String(rawOffset)) || !/^\d+$/.test(String(rawLimit))) {
    res.status(400).json({ error: 'offset and limit must be non-negative integers' }); return null;
  }
  const offset = Number(rawOffset);
  const limit = Number(rawLimit);
  const severity = req.query.severity ? String(req.query.severity) : '';
  const q = req.query.q ? String(req.query.q).trim() : '';
  if (limit < 1 || limit > 200) { res.status(400).json({ error: 'limit must be between 1 and 200' }); return null; }
  if (offset < 0 || !Number.isSafeInteger(offset)) { res.status(400).json({ error: 'invalid offset' }); return null; }
  if (severity && !severities.includes(severity)) { res.status(400).json({ error: 'unknown severity' }); return null; }
  if (q.length > 200) { res.status(400).json({ error: 'q too long' }); return null; }
  return { offset, limit, severity, q };
}

app.get('/api/logs', async (req, res) => {
  try {
    const p = parseLogsParams(req, res); if (!p) return;
    const conditions = [];
    const params = [];
    if (p.severity) { params.push(p.severity); conditions.push(`severity = $${params.length}`); }
    if (p.q) { params.push(`%${p.q.toLowerCase().replace(/[\\%_]/g, m => '\\' + m)}%`); conditions.push(`message_lc LIKE $${params.length} ESCAPE '\\'`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const totalSql = `SELECT COUNT(*)::int AS total FROM logs ${where}`;
    const pageSql = `SELECT id, ts, severity, service, message FROM logs ${where} ORDER BY ts DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const [totalResult, pageResult] = await Promise.all([
      db.query(totalSql, params),
      db.query(pageSql, [...params, p.limit, p.offset])
    ]);
    res.json({ total: Number(totalResult.rows[0]?.total || 0), rows: pageResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const total = await db.query('SELECT COUNT(*)::int AS total FROM logs');
    const sev = await db.query('SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity');
    const perSeverity = Object.fromEntries(severities.map(s => [s, 0]));
    for (const r of sev.rows) perSeverity[r.severity] = Number(r.count);
    res.json({ total: Number(total.rows[0].total), perSeverity });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'stats failed' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

init().then(() => {
  app.listen(PORT, () => console.log(`log explorer server listening on http://localhost:${PORT}`));
}).catch(err => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
