import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DB_DIR = process.env.PGLITE_DATA_DIR || path.join(ROOT, 'data', 'pglite');
const PORT = Number(process.env.PORT || 3000);
const ROW_COUNT = 100_000;
const MAX_LIMIT = 200;
const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const totalCache = new Map();
const responseCache = new Map();
const MAX_RESPONSE_CACHE = 256;

fs.mkdirSync(DB_DIR, { recursive: true });
const db = new PGlite(DB_DIR);

function esc(s) {
  return String(s).replace(/'/g, "''");
}

function makeMessage(i, severity, service) {
  const user = `user-${(i * 7919) % 5000}`;
  const request = `req-${String((i * 104729) % 1_000_000).padStart(6, '0')}`;
  const region = ['us-east', 'us-west', 'eu-central', 'ap-south'][(i * 13) % 4];
  const host = `host-${(i * 17) % 256}`;
  const latency = 5 + ((i * 37) % 2500);
  const path = ['/api/login', '/api/search', '/api/orders', '/api/payments', '/api/profile', '/worker/sync', '/health', '/admin/report'][(i * 19) % 8];

  const common = [
    `request completed ${request} ${path} for ${user} in ${latency}ms from ${region}`,
    `cache lookup ${request} key session:${(i * 23) % 10000} ${i % 3 === 0 ? 'cache hit' : 'cache miss'} on ${host}`,
    `database query ${request} ${i % 11 === 0 ? 'slow query' : 'completed'} rows=${(i * 29) % 900} service=${service}`,
    `background job ${request} shard=${(i * 31) % 64} processed batch successfully`,
    `feature flag evaluation ${request} flag=checkout_v${(i % 5) + 1} cohort=${(i * 7) % 100}`,
    `auth token refreshed ${request} principal=${user} region=${region}`,
  ];
  const warn = [
    `retry scheduled ${request} downstream timeout from ${service} to billing attempt=${(i % 3) + 1}`,
    `rate limit nearing threshold ${request} client=${user} remaining=${(i * 5) % 100}`,
    `queue lag warning ${request} queue=critical lagMs=${latency * 3} shard=${(i * 31) % 64}`,
  ];
  const error = [
    `payment failure ${request} provider=stripe code=E${1000 + (i % 70)} customer=${user}`,
    `uncaught exception ${request} TypeError module=${service} trace=ERR_${(i * 41) % 999}`,
    `database connection error ${request} pool exhausted timeout critical incident host=${host}`,
  ];
  const debug = [
    `debug trace ${request} state transition from S${i % 9} to S${(i + 1) % 9} correlation=${(i * 43) % 100000}`,
    `debug payload sample ${request} bytes=${(i * 47) % 16384} sanitized=true path=${path}`,
  ];

  let list = common;
  if (severity === 'warn') list = warn.concat(common);
  if (severity === 'error') list = error.concat(warn);
  if (severity === 'debug') list = debug.concat(common);
  const msg = list[i % list.length];
  return `${msg} service=${service}`;
}

function deterministicRow(i) {
  // Insert newest first-ish across a deterministic 30 day span. One row every ~25.92s.
  const start = Date.UTC(2025, 0, 1, 0, 0, 0);
  const stepMs = Math.floor((30 * 24 * 60 * 60 * 1000) / ROW_COUNT);
  const jitterMs = ((i * 9301 + 49297) % 233280) % 1000;
  const ts = new Date(start + i * stepMs + jitterMs).toISOString();
  const r = (i * 9973) % 100;
  const severity = r < 60 ? 'debug' : r < 85 ? 'info' : r < 95 ? 'warn' : 'error';
  const service = ['api-gateway', 'auth', 'billing', 'catalog', 'checkout', 'notifications', 'search', 'worker'][(i * 37) % 8];
  return { id: i + 1, ts, severity, service, message: makeMessage(i, severity, service) };
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL,
      message_lc TEXT NOT NULL
    );
  `);

  const result = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const count = Number(result.rows[0]?.count || 0);
  if (count !== ROW_COUNT) {
    console.log(`[seed] logs table has ${count} rows; rebuilding deterministic ${ROW_COUNT} row corpus`);
    const start = Date.now();
    await db.exec('BEGIN; DELETE FROM logs;');
    const batchSize = 1000;
    for (let base = 0; base < ROW_COUNT; base += batchSize) {
      const values = [];
      const end = Math.min(base + batchSize, ROW_COUNT);
      for (let i = base; i < end; i++) {
        const row = deterministicRow(i);
        values.push(`(${row.id}, '${esc(row.ts)}', '${row.severity}', '${row.service}', '${esc(row.message)}', '${esc(row.message.toLowerCase())}')`);
      }
      await db.exec(`INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${values.join(',')};`);
      if ((base / batchSize) % 10 === 0) console.log(`[seed] inserted ${end}/${ROW_COUNT}`);
    }
    await db.exec('COMMIT;');
    console.log(`[seed] completed in ${Date.now() - start}ms`);
  } else {
    console.log('[seed] existing corpus detected; skipping seed');
  }

  console.log('[db] creating indexes if needed');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_message_lc ON logs (message_lc);
  `);

  totalCache.clear();
  totalCache.set('*\u0000*', ROW_COUNT);
  const counts = await db.query('SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity');
  for (const row of counts.rows) totalCache.set(`${row.severity}\u0000*`, Number(row.count));
}

function parseLogsQuery(req, res) {
  const offsetRaw = req.query.offset ?? '0';
  const limitRaw = req.query.limit ?? '100';
  if (!/^\d+$/.test(String(offsetRaw)) || !/^\d+$/.test(String(limitRaw))) {
    res.status(400).json({ error: 'offset and limit must be non-negative integers' });
    return null;
  }
  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    res.status(400).json({ error: 'offset must be a non-negative integer' });
    return null;
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
    return null;
  }
  const severity = req.query.severity ? String(req.query.severity) : '';
  if (severity && !VALID_SEVERITIES.has(severity)) {
    res.status(400).json({ error: 'unknown severity' });
    return null;
  }
  const q = req.query.q ? String(req.query.q).trim().toLowerCase() : '';
  if (q.length > 256) {
    res.status(400).json({ error: 'q must be at most 256 characters' });
    return null;
  }
  return { offset, limit, severity, q };
}

function buildWhere({ severity, q }) {
  const clauses = [];
  const params = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    clauses.push(`message_lc LIKE $${params.length}`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function filterKey({ severity, q }) {
  return `${severity || '*'}\u0000${q || '*'}`;
}

function responseKey(parsed) {
  return `${filterKey(parsed)}\u0000${parsed.offset}\u0000${parsed.limit}`;
}

function rememberResponse(key, value) {
  responseCache.set(key, value);
  if (responseCache.size > MAX_RESPONSE_CACHE) responseCache.delete(responseCache.keys().next().value);
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/logs', async (req, res) => {
  try {
    const parsed = parseLogsQuery(req, res);
    if (!parsed) return;
    const cached = responseCache.get(responseKey(parsed));
    if (cached) {
      res.set('X-Cache', 'hit');
      res.json(cached);
      return;
    }

    const { offset, limit } = parsed;
    const { where, params } = buildWhere(parsed);
    const fKey = filterKey(parsed);

    const totalSql = `SELECT COUNT(*)::int AS total FROM logs ${where}`;
    const rowsSql = `
      SELECT id, ts, severity, service, message
      FROM logs
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    let totalPromise = totalCache.has(fKey)
      ? Promise.resolve(totalCache.get(fKey))
      : db.query(totalSql, params).then((r) => {
          const t = Number(r.rows[0]?.total || 0);
          totalCache.set(fKey, t);
          return t;
        });
    const [total, rowsResult] = await Promise.all([
      totalPromise,
      db.query(rowsSql, [...params, limit, offset]),
    ]);
    const payload = { total, rows: rowsResult.rows };
    rememberResponse(responseKey(parsed), payload);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const result = await db.query(`
      SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity
      UNION ALL
      SELECT 'total' AS severity, COUNT(*)::int AS count FROM logs
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

await initDb();
app.listen(PORT, () => {
  console.log(`log explorer API listening on http://localhost:${PORT}`);
});
