import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LruCache } from './queryCache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = process.env.PGLITE_DATA_DIR || path.join(rootDir, '.pgdata');
const PORT = Number(process.env.PORT || 3000);
const ROW_COUNT = 100_000;
const BATCH_SIZE = 1000;
const SINGLE_QUOTE_RE = /'/g;
const MAX_LIMIT = 200;
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const SERVICES = ['auth', 'billing', 'checkout', 'catalog', 'gateway', 'search', 'worker', 'notifications'];
const COMPONENTS = ['cache', 'database', 'queue', 'scheduler', 'http-client', 'rate-limiter', 'serializer', 'replica'];
const REGIONS = ['iad', 'sfo', 'fra', 'sin', 'syd'];
const ACTIONS = [
  'accepted request',
  'completed request',
  'retried downstream call',
  'refreshed cache entry',
  'validated payload',
  'processed job',
  'published event',
  'reconciled state',
];
const WARN_MESSAGES = [
  'high latency observed',
  'rate limit nearing capacity',
  'retry budget partially consumed',
  'cache miss spike detected',
  'slow query plan selected',
];
const ERROR_MESSAGES = [
  'timeout contacting upstream',
  'failed to persist record',
  'dependency returned error',
  'circuit breaker opened',
  'dead letter queue write failed',
];
const totalCache = new LruCache(256);
const statsCache = { value: null };
const severityTotals = { debug: 25_000, info: 60_000, warn: 10_000, error: 5_000 };

await mkdir(dataDir, { recursive: true });
const db = new PGlite(dataDir);

function severityFor(i) {
  const n = i % 100;
  if (n < 60) return 'info';
  if (n < 85) return 'debug';
  if (n < 95) return 'warn';
  return 'error';
}

function deterministicRow(i) {
  const severity = severityFor(i);
  const service = SERVICES[i % SERVICES.length];
  const component = COMPONENTS[(i * 7) % COMPONENTS.length];
  const region = REGIONS[(i * 11) % REGIONS.length];
  const requestId = `req-${String((i * 48271) % 999983).padStart(6, '0')}`;
  const userBucket = (i * 37) % 1000;
  const latency = 8 + ((i * 17) % 1200);
  const shard = (i * 13) % 64;

  let phrase;
  if (severity === 'warn') phrase = WARN_MESSAGES[(i * 3) % WARN_MESSAGES.length];
  else if (severity === 'error') phrase = ERROR_MESSAGES[(i * 5) % ERROR_MESSAGES.length];
  else phrase = ACTIONS[(i * 3) % ACTIONS.length];

  // Spread exactly over 30 days, newest rows have the largest i and therefore the largest timestamp.
  const base = Date.UTC(2025, 0, 1, 0, 0, 0);
  const spanMs = 30 * 24 * 60 * 60 * 1000;
  const ts = new Date(base + Math.floor((i / ROW_COUNT) * spanMs)).toISOString();
  const message = `${phrase} service=${service} component=${component} region=${region} request=${requestId} user_bucket=${userBucket} shard=${shard} latency_ms=${latency} corpus_marker=deterministic sample=${i % 257}`;
  return { ts, severity, service, message, message_lc: message.toLowerCase() };
}

async function setupSchema() {
  const existing = await db.query("SELECT to_regclass('public.logs') AS table_name");
  if (existing.rows[0]?.table_name) {
    const revCol = await db.query("SELECT COUNT(*)::int AS count FROM information_schema.columns WHERE table_name = 'logs' AND column_name = 'rev_id'");
    if (Number(revCol.rows[0]?.count || 0) === 0) {
      console.log('Existing database uses an older schema; rebuilding deterministic corpus with rev_id support.');
      await db.exec('DROP TABLE logs;');
    }
  }
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL,
      message_lc TEXT NOT NULL,
      rev_id INTEGER NOT NULL
    );
  `);
}

async function ensureIndexes() {
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_rev_id ON logs (rev_id);
    CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_message_lc ON logs (message_lc);
    CREATE INDEX IF NOT EXISTS idx_logs_message_lc_pattern ON logs (message_lc text_pattern_ops);
    ANALYZE logs;
  `);
}

async function seed() {
  const existing = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const count = Number(existing.rows[0]?.count || 0);
  if (count === ROW_COUNT) {
    console.log(`Seed skipped: ${ROW_COUNT} rows already present.`);
    await ensureIndexes();
    totalCache.set('\u0000', ROW_COUNT);
    for (const [severity, total] of Object.entries(severityTotals)) totalCache.set(`${severity}\u0000`, total);
    return;
  }

  totalCache.set('\u0000', ROW_COUNT);
  for (const [severity, total] of Object.entries(severityTotals)) totalCache.set(`${severity}\u0000`, total);

  if (count !== 0) {
    console.log(`Found ${count} rows, reseeding to restore deterministic ${ROW_COUNT}-row corpus.`);
    await db.exec('TRUNCATE logs;');
  } else {
    console.log(`Seeding ${ROW_COUNT} deterministic log rows...`);
  }

  const start = Date.now();
  await db.exec('BEGIN;');
  try {
    for (let first = 1; first <= ROW_COUNT; first += BATCH_SIZE) {
      const values = [];
      const last = Math.min(ROW_COUNT, first + BATCH_SIZE - 1);
      for (let id = first; id <= last; id++) {
        const row = deterministicRow(id);
        const esc = (s) => String(s).replace(SINGLE_QUOTE_RE, "''");
        const revId = ROW_COUNT - id;
        values.push(`(${id}, '${esc(row.ts)}', '${row.severity}', '${esc(row.service)}', '${esc(row.message)}', '${esc(row.message_lc)}', ${revId})`);
      }
      await db.exec(
        `INSERT INTO logs (id, ts, severity, service, message, message_lc, rev_id) VALUES ${values.join(',')}`,
      );
      if ((last % 10_000) === 0) console.log(`  seeded ${last}/${ROW_COUNT}`);
    }
    await db.exec('COMMIT;');
  } catch (err) {
    await db.exec('ROLLBACK;');
    throw err;
  }
  await ensureIndexes();
  console.log(`Seed complete in ${Date.now() - start}ms.`);
}

function parseLogsQuery(req) {
  const offsetRaw = req.query.offset ?? '0';
  const limitRaw = req.query.limit ?? '100';
  if (!/^\d+$/.test(String(offsetRaw))) throw Object.assign(new Error('offset must be a non-negative integer'), { status: 400 });
  if (!/^\d+$/.test(String(limitRaw))) throw Object.assign(new Error('limit must be an integer from 1 to 200'), { status: 400 });
  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(offset) || offset < 0) throw Object.assign(new Error('offset must be a non-negative integer'), { status: 400 });
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw Object.assign(new Error('limit must be between 1 and 200'), { status: 400 });

  const severity = req.query.severity ? String(req.query.severity).toLowerCase() : '';
  if (severity && !SEVERITIES.has(severity)) throw Object.assign(new Error('unknown severity'), { status: 400 });
  const q = req.query.q == null ? '' : String(req.query.q).trim().toLowerCase();
  if (q.length > 200) throw Object.assign(new Error('q is too long'), { status: 400 });
  return { offset, limit, severity, q };
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function buildWhere({ severity, q }) {
  const clauses = [];
  const params = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push(`%${escapeLike(q)}%`);
    clauses.push(`message_lc LIKE $${params.length} ESCAPE '\\'`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/logs', async (req, res, next) => {
  try {
    const parsed = parseLogsQuery(req);
    const { where, params } = buildWhere(parsed);
    const countSql = `SELECT COUNT(*)::int AS total FROM logs ${where}`;
    const rowsSql = !parsed.severity && !parsed.q
      ? `
        SELECT id, ts, severity, service, message
        FROM logs
        WHERE rev_id >= $1
        ORDER BY rev_id ASC
        LIMIT $2
      `
      : `
        SELECT id, ts, severity, service, message
        FROM logs
        ${where}
        ORDER BY ts DESC, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;
    const cacheKey = `${parsed.severity}\u0000${parsed.q}`;
    let total = totalCache.get(cacheKey);
    if (total === undefined && !parsed.q && !parsed.severity) total = ROW_COUNT;
    if (total === undefined && !parsed.q && parsed.severity) total = severityTotals[parsed.severity];
    const rowParams = !parsed.severity && !parsed.q ? [parsed.offset, parsed.limit] : [...params, parsed.limit, parsed.offset];
    const rowsResult = await db.query(rowsSql, rowParams);
    if (total === undefined) {
      const countResult = await db.query(countSql, params);
      total = Number(countResult.rows[0]?.total || 0);
      totalCache.set(cacheKey, total);
    }
    res.set('Cache-Control', 'no-store');
    res.json({
      total,
      rows: parsed.offset >= total ? [] : rowsResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/stats', async (_req, res, next) => {
  try {
    if (!statsCache.value) {
      const totalResult = await db.query('SELECT COUNT(*)::int AS total FROM logs');
      const severityResult = await db.query(`
        SELECT severity, COUNT(*)::int AS count
        FROM logs
        GROUP BY severity
      `);
      const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
      for (const row of severityResult.rows) bySeverity[row.severity] = Number(row.count);
      statsCache.value = { total: Number(totalResult.rows[0]?.total || 0), bySeverity, perSeverity: bySeverity };
    }
    res.set('Cache-Control', 'no-store');
    res.json(statsCache.value);
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'internal server error' });
});

await setupSchema();
await seed();

app.listen(PORT, () => {
  console.log(`Log explorer API listening on http://localhost:${PORT}`);
});
