import express from 'express';
import cors from 'cors';
import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.PGLITE_DATA_DIR || './.pglite';
const ROW_COUNT = 100_000;
const MAX_LIMIT = 200;
const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);

const services = [
  'api-gateway',
  'auth-service',
  'billing-worker',
  'catalog-api',
  'checkout',
  'notification',
  'search-indexer',
  'scheduler',
];

const regions = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'];
const eventTemplates = [
  'request completed',
  'database query executed',
  'cache lookup finished',
  'queue dispatch acknowledged',
  'authentication check completed',
  'payment workflow advanced',
  'feature flag evaluated',
  'health probe answered',
  'retry policy considered',
  'background job checkpointed',
];

let db;
let cachedStats = null;
const countCache = new Map();
const windowCache = new Map();
const WINDOW_CACHE_LIMIT = 500;

function severityForOrdinal(i) {
  const bucket = i % 100;
  if (bucket < 60) return 'debug';
  if (bucket < 85) return 'info';
  if (bucket < 95) return 'warn';
  return 'error';
}

function timestampForOrdinal(i) {
  const start = Date.UTC(2024, 0, 1, 0, 0, 0);
  const span = 30 * 24 * 60 * 60 * 1000;
  const ts = new Date(start + Math.floor((i * span) / ROW_COUNT));
  return ts.toISOString().slice(0, 19).replace('T', ' ');
}

function messageForOrdinal(i, severity, service) {
  const template = eventTemplates[i % eventTemplates.length];
  const region = regions[i % regions.length];
  const tenant = `tenant-${String((i * 17) % 997).padStart(3, '0')}`;
  const requestId = `req-${String(i).padStart(6, '0')}`;
  const latency = 5 + ((i * 37) % 2_000);
  const status = severity === 'error' ? 500 + (i % 24) : severity === 'warn' ? 400 + (i % 50) : 200 + (i % 9);
  const fragments = [];

  // Purposefully mixed selectivity for substring tests.
  if (i % 2 === 0) fragments.push('common=request');
  if (i % 10 === 0) fragments.push('cache');
  if (i % 25 === 0) fragments.push('timeout');
  if (i % 997 === 0) fragments.push('rare-sentinel');
  if (i % 5000 === 0) fragments.push('needle');
  if (severity === 'error') fragments.push('exception stacktrace');
  if (severity === 'warn') fragments.push('slow-path');

  return `${template}; service=${service}; region=${region}; ${requestId}; tenant=${tenant}; status=${status}; latency_ms=${latency}; ${fragments.join(' ')}`.trim();
}

async function createSchema() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);
}

async function ensureIndexes() {
  await db.exec(`
    CREATE INDEX IF NOT EXISTS logs_ts_desc_idx ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS logs_severity_ts_desc_idx ON logs (severity, ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS logs_lower_message_idx ON logs (lower(message));
  `);

  // pg_trgm is available in many PGLite builds. The app works without it, but
  // uses it automatically when present for ILIKE '%term%' query shapes.
  try {
    await db.exec(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE INDEX IF NOT EXISTS logs_message_trgm_idx ON logs USING gin (message gin_trgm_ops);
    `);
  } catch (error) {
    console.warn('pg_trgm is not available; substring search will use a sequential text predicate.');
  }
  await db.exec('ANALYZE logs');
}

async function seedIfNeeded() {
  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const existing = Number(countResult.rows[0]?.count || 0);
  if (existing === ROW_COUNT) return;

  console.log(`Seeding ${ROW_COUNT.toLocaleString()} deterministic log rows...`);
  const started = Date.now();
  await db.exec('BEGIN');
  try {
    if (existing !== 0) await db.exec('TRUNCATE TABLE logs');
    const batchSize = 500;
    for (let start = 1; start <= ROW_COUNT; start += batchSize) {
      const values = [];
      const params = [];
      let p = 1;
      const end = Math.min(start + batchSize - 1, ROW_COUNT);
      for (let id = start; id <= end; id += 1) {
        const service = services[(id - 1) % services.length];
        const severity = severityForOrdinal(id - 1);
        const ts = timestampForOrdinal(id - 1);
        const message = messageForOrdinal(id - 1, severity, service);
        values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(id, ts, severity, service, message);
      }
      await db.query(
        `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')}`,
        params,
      );
    }
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
  console.log(`Seed completed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
}

async function loadStats() {
  const result = await db.query(`
    SELECT severity, COUNT(*)::int AS count
    FROM logs
    GROUP BY severity
  `);
  const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
  for (const row of result.rows) bySeverity[row.severity] = Number(row.count);
  cachedStats = {
    total: Object.values(bySeverity).reduce((sum, value) => sum + value, 0),
    severities: bySeverity,
  };
}

function parseLogsQuery(query) {
  const offsetRaw = query.offset ?? '0';
  const limitRaw = query.limit ?? '100';
  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);
  const severity = query.severity ? String(query.severity) : '';
  const q = query.q ? String(query.q).trim() : '';

  if (!Number.isInteger(offset) || offset < 0) {
    return { error: 'offset must be a non-negative integer' };
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { error: `limit must be an integer between 1 and ${MAX_LIMIT}` };
  }
  if (severity && !VALID_SEVERITIES.has(severity)) {
    return { error: 'severity must be one of debug, info, warn, error' };
  }
  if (q.length > 200) {
    return { error: 'q must be at most 200 characters' };
  }
  return { offset, limit, severity, q };
}

function buildFilteredWhere({ severity, q }, params) {
  const clauses = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    clauses.push(`message ILIKE $${params.length}`);
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

function rememberWindow(key, value) {
  windowCache.set(key, value);
  if (windowCache.size > WINDOW_CACHE_LIMIT) {
    const oldest = windowCache.keys().next().value;
    windowCache.delete(oldest);
  }
}

async function queryLogs(parsed) {
  const { offset, limit, severity, q } = parsed;
  const cacheKey = JSON.stringify({ offset, limit, severity, q: q.toLowerCase() });
  const cached = windowCache.get(cacheKey);
  if (cached) return cached;

  // Fast path for the most common unfiltered virtual scrolling request. The seed
  // is strictly increasing in both id and timestamp, so ts DESC is id DESC.
  if (!severity && !q) {
    const total = cachedStats?.total ?? ROW_COUNT;
    if (offset >= total) return { total, rows: [] };
    const maxId = total - offset;
    const minExclusive = Math.max(0, maxId - limit);
    const rows = await db.query(
      `SELECT id, ts::text AS ts, severity, service, message
       FROM logs
       WHERE id <= $1 AND id > $2
       ORDER BY id DESC
       LIMIT $3`,
      [maxId, minExclusive, limit],
    );
    const result = { total, rows: rows.rows };
    rememberWindow(cacheKey, result);
    return result;
  }

  const countParams = [];
  const where = buildFilteredWhere(parsed, countParams);
  const countKey = JSON.stringify({ severity, q: q.toLowerCase() });
  let total = countCache.get(countKey);
  if (total === undefined) {
    const totalResult = await db.query(`SELECT COUNT(*)::int AS total FROM logs ${where}`, countParams);
    total = Number(totalResult.rows[0]?.total || 0);
    countCache.set(countKey, total);
  }
  if (offset >= total) {
    const result = { total, rows: [] };
    rememberWindow(cacheKey, result);
    return result;
  }

  const rowParams = [...countParams, limit, offset];
  const rowsResult = await db.query(
    `SELECT id, ts::text AS ts, severity, service, message
     FROM logs
     ${where}
     ORDER BY ts DESC, id DESC
     LIMIT $${countParams.length + 1}
     OFFSET $${countParams.length + 2}`,
    rowParams,
  );
  const result = { total, rows: rowsResult.rows };
  rememberWindow(cacheKey, result);
  return result;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  db = new PGlite(DATA_DIR);
  await createSchema();
  await seedIfNeeded();
  await ensureIndexes();
  await loadStats();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/stats', (_req, res) => {
    res.json(cachedStats);
  });

  app.get('/api/logs', async (req, res, next) => {
    try {
      const parsed = parseLogsQuery(req.query);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const result = await queryLogs(parsed);
      // Defensive guard for the hard response-size requirement.
      if (result.rows.length > MAX_LIMIT) result.rows = result.rows.slice(0, MAX_LIMIT);
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: 'internal server error' });
  });

  app.listen(PORT, () => {
    console.log(`Log explorer API listening on http://localhost:${PORT}`);
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
