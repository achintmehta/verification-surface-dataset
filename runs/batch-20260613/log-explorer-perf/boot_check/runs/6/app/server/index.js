import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'pglite-data');
const PORT = process.env.PORT || 3000;
const ROW_COUNT = 100000;
const BATCH_SIZE = 5000;
const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new PGlite(DATA_DIR);

function severityFor(i) {
  const n = i % 100;
  if (n < 60) return 'debug';
  if (n < 85) return 'info';
  if (n < 95) return 'warn';
  return 'error';
}

const services = ['auth', 'billing', 'catalog', 'checkout', 'edge', 'inventory', 'notifications', 'search'];
const actions = ['accepted', 'validated', 'retried', 'completed', 'rejected', 'queued', 'dispatched', 'indexed'];
const entities = ['session', 'invoice', 'cart', 'order', 'token', 'profile', 'shipment', 'document'];
const regions = ['us-east', 'us-west', 'eu-central', 'ap-south'];
const templates = [
  (i, service) => `request ${actions[i % actions.length]} for ${entities[(i * 3) % entities.length]} id=${1000000 + i} trace=trace-${(i * 7919) % 100000} region=${regions[i % regions.length]}`,
  (i, service) => `cache ${i % 7 === 0 ? 'miss' : 'hit'} on key ${service}:${entities[i % entities.length]}:${(i * 17) % 5000} latency=${5 + (i % 250)}ms`,
  (i, service) => `worker processed batch=${(i * 13) % 10000} size=${1 + (i % 64)} status=${i % 23 === 0 ? 'slow' : 'ok'} shard=${i % 32}`,
  (i, service) => `database query ${i % 31 === 0 ? 'timeout warning' : 'completed'} rows=${(i * 19) % 2000} connection=pool-${i % 12}`,
  (i, service) => `user workflow step ${i % 11} ${i % 97 === 0 ? 'needle-critical-path' : 'normal-path'} correlation=corr-${(i * 104729) % 1000000}`,
  (i, service) => `rate limiter ${i % 41 === 0 ? 'throttled' : 'allowed'} client=client-${i % 3000} quota=${1000 - (i % 300)}`,
];

function esc(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function initialize() {
  console.log('initializing database...');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  const countRes = await db.query('SELECT count(*)::int AS count FROM logs');
  const count = Number(countRes.rows[0]?.count || 0);
  if (count !== ROW_COUNT) {
    if (count > 0) {
      console.log(`found ${count} rows, rebuilding deterministic corpus...`);
      await db.exec('TRUNCATE logs');
    } else {
      console.log('seeding deterministic corpus...');
    }
    const base = Date.UTC(2024, 0, 31, 23, 59, 59);
    const spanMs = 30 * 24 * 60 * 60 * 1000;
    for (let start = 1; start <= ROW_COUNT; start += BATCH_SIZE) {
      const end = Math.min(ROW_COUNT, start + BATCH_SIZE - 1);
      const values = [];
      for (let id = start; id <= end; id++) {
        const idx = id - 1;
        // id order == timestamp desc order; one deterministic point in a 30-day span.
        const ts = new Date(base - Math.floor((idx * spanMs) / ROW_COUNT)).toISOString();
        const severity = severityFor(idx);
        const service = services[idx % services.length];
        let msg = templates[idx % templates.length](idx, service);
        if (severity === 'error') msg += ` error_code=E${1000 + (idx % 900)} failure=${idx % 2 ? 'transient' : 'permanent'}`;
        if (severity === 'warn') msg += ` warn_code=W${100 + (idx % 200)} threshold=${70 + (idx % 30)}`;
        values.push(`(${id}, ${esc(ts)}, ${esc(severity)}, ${esc(service)}, ${esc(msg)})`);
      }
      await db.exec(`INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')}`);
      console.log(`seeded ${end}/${ROW_COUNT}`);
    }
  } else {
    console.log(`database already seeded with ${ROW_COUNT} rows`);
  }

  console.log('creating indexes...');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_logs_lower_message ON logs (lower(message));
  `);
  console.log('database ready');
}

function parseLogsQuery(req) {
  const offsetRaw = req.query.offset ?? '0';
  const limitRaw = req.query.limit ?? '100';
  if (!/^\d+$/.test(String(offsetRaw))) throw new Error('offset must be a non-negative integer');
  if (!/^\d+$/.test(String(limitRaw))) throw new Error('limit must be an integer between 1 and 200');
  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be between 1 and 200');
  const severity = req.query.severity ? String(req.query.severity).toLowerCase() : '';
  if (severity && !VALID_SEVERITIES.has(severity)) throw new Error('unknown severity');
  const q = req.query.q ? String(req.query.q).trim() : '';
  return { offset, limit, severity, q };
}

function whereClause({ severity, q }) {
  const parts = [];
  if (severity) parts.push(`severity = ${esc(severity)}`);
  if (q) parts.push(`message ILIKE ${esc('%' + q.replace(/[%_\\]/g, ch => '\\' + ch) + '%')} ESCAPE '\\'`);
  return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(ROOT, 'dist')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/logs', async (req, res) => {
  try {
    const params = parseLogsQuery(req);
    const where = whereClause(params);
    const [totalResult, rowsResult] = await Promise.all([
      db.query(`SELECT count(*)::int AS total FROM logs ${where}`),
      db.query(`SELECT id, ts, severity, service, message FROM logs ${where} ORDER BY ts DESC, id ASC LIMIT ${params.limit} OFFSET ${params.offset}`)
    ]);
    res.json({ total: Number(totalResult.rows[0]?.total || 0), rows: rowsResult.rows });
  } catch (err) {
    if (['offset', 'limit', 'unknown severity'].some(s => String(err.message).includes(s))) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT severity, count(*)::int AS count FROM logs GROUP BY severity
      UNION ALL SELECT 'total' AS severity, count(*)::int AS count FROM logs
    `);
    const severities = { debug: 0, info: 0, warn: 0, error: 0 };
    let total = 0;
    for (const row of result.rows) {
      if (row.severity === 'total') total = Number(row.count);
      else severities[row.severity] = Number(row.count);
    }
    res.json({ total, severities });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const index = path.join(ROOT, 'dist', 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  next();
});

initialize().then(() => {
  app.listen(PORT, () => console.log(`log explorer server listening on ${PORT}`));
}).catch(err => {
  console.error('failed to start', err);
  process.exit(1);
});
