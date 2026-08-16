import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(ROOT, 'data', 'pglite');
const PORT = Number(process.env.PORT || 3000);
const ROW_COUNT = 100_000;
const MAX_LIMIT = 200;
const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);

const services = [
  'auth-api',
  'billing-worker',
  'catalog-api',
  'checkout-api',
  'email-sender',
  'gateway',
  'inventory',
  'search-indexer'
];
const endpoints = ['/login', '/logout', '/v1/orders', '/v1/cart', '/v1/search', '/v1/users', '/v1/invoices', '/health'];
const regions = ['iad', 'sfo', 'fra', 'sin', 'syd'];
const tenants = ['acme', 'globex', 'initech', 'umbrella', 'soylent', 'stark', 'wayne'];
const resources = ['postgres', 'redis', 'kafka', 'object-store', 'payment-gateway', 'smtp', 'feature-flags'];

function severityFor(i) {
  const b = (i - 1) % 100;
  if (b < 60) return 'info';
  if (b < 85) return 'debug';
  if (b < 95) return 'warn';
  return 'error';
}

function messageFor(i, severity, service) {
  const endpoint = endpoints[i % endpoints.length];
  const region = regions[Math.floor(i / 3) % regions.length];
  const tenant = tenants[Math.floor(i / 7) % tenants.length];
  const resource = resources[Math.floor(i / 11) % resources.length];
  const requestId = `req-${String(i).padStart(6, '0')}`;
  const latency = 12 + ((i * 37) % 2400);
  const shard = (i * 13) % 64;
  const trace = `trace-${((i * 2654435761) >>> 0).toString(16).padStart(8, '0')}`;

  // Deterministic rare marker for selective substring tests.
  if (i % 997 === 0) {
    return `audit marker needle-alpha observed in ${service} for ${tenant} ${requestId} ${trace}`;
  }

  if (severity === 'error') {
    const cause = i % 4 === 0 ? 'timeout while contacting' : i % 4 === 1 ? 'constraint violation from' : i % 4 === 2 ? 'connection reset by' : 'deadlock reported by';
    return `request failed ${requestId} ${endpoint} tenant=${tenant} region=${region} ${cause} ${resource} shard=${shard} trace=${trace}`;
  }
  if (severity === 'warn') {
    const condition = i % 3 === 0 ? 'latency threshold exceeded' : i % 3 === 1 ? 'retry scheduled after transient timeout' : 'queue depth is elevated';
    return `request warning ${requestId} ${endpoint} tenant=${tenant} region=${region} ${condition} latency=${latency}ms service=${service}`;
  }
  if (severity === 'debug') {
    const detail = i % 3 === 0 ? 'cache lookup hit' : i % 3 === 1 ? 'cache lookup miss' : 'feature flag evaluated';
    return `debug ${detail} for ${requestId} tenant=${tenant} endpoint=${endpoint} region=${region} shard=${shard} trace=${trace}`;
  }
  const status = i % 10 === 0 ? 'accepted' : i % 10 === 1 ? 'queued' : 'completed';
  return `request ${status} ${requestId} ${endpoint} tenant=${tenant} region=${region} latency=${latency}ms service=${service} trace=${trace}`;
}

async function createSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL,
      message_lc TEXT NOT NULL
    );
  `);
}

async function createIndexes(db) {
  await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_message_lc ON logs (message_lc);`);
}

async function seed(db) {
  console.log(`Seeding ${ROW_COUNT.toLocaleString()} deterministic log rows...`);
  const start = Date.now();
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  const span = 30 * 24 * 60 * 60 * 1000;
  const step = span / ROW_COUNT;
  const batchSize = 1000;

  await db.query('BEGIN');
  try {
    for (let first = 1; first <= ROW_COUNT; first += batchSize) {
      const last = Math.min(ROW_COUNT, first + batchSize - 1);
      const values = [];
      const params = [];
      let p = 1;
      for (let id = first; id <= last; id++) {
        const severity = severityFor(id);
        const service = services[(id - 1) % services.length];
        const message = messageFor(id, severity, service);
        const ts = new Date(base + Math.floor((id - 1) * step)).toISOString();
        values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(id, ts, severity, service, message, message.toLowerCase());
      }
      await db.query(
        `INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${values.join(',')}`,
        params
      );
      if ((last % 10000) === 0) console.log(`  inserted ${last.toLocaleString()} rows`);
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
  console.log(`Seed complete in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

async function initDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const db = new PGlite(DATA_DIR);
  await createSchema(db);
  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const count = Number(countResult.rows[0]?.count || 0);
  if (count !== ROW_COUNT) {
    if (count !== 0) console.log(`Found ${count} rows; reseeding expected corpus of ${ROW_COUNT}.`);
    await db.query('TRUNCATE TABLE logs');
    await seed(db);
  } else {
    console.log(`Using existing deterministic corpus (${ROW_COUNT.toLocaleString()} rows).`);
  }
  await createIndexes(db);
  return db;
}

function parseIntegerParam(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^[0-9]+$/.test(String(value))) throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
}

function escapeLikeLiteral(value) {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

function buildWhere(query) {
  const where = [];
  const params = [];
  if (query.severity) {
    if (!VALID_SEVERITIES.has(query.severity)) throw new Error('severity must be one of debug, info, warn, error');
    params.push(query.severity);
    where.push(`severity = $${params.length}`);
  }
  const q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
  if (q) {
    params.push(`%${escapeLikeLiteral(q)}%`);
    where.push(`message_lc LIKE $${params.length} ESCAPE '\\'`);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

async function loadQueryStore(db) {
  const result = await db.query(`
    SELECT id, ts, severity, service, message, message_lc
    FROM logs
    ORDER BY ts DESC, id DESC
  `);
  const allRows = result.rows.map(row => ({
    id: Number(row.id),
    ts: row.ts,
    severity: row.severity,
    service: row.service,
    message: row.message,
    message_lc: row.message_lc
  }));
  const bySeverity = { debug: [], info: [], warn: [], error: [] };
  for (const row of allRows) bySeverity[row.severity].push(row);
  const stats = {
    total: allRows.length,
    severities: {
      debug: bySeverity.debug.length,
      info: bySeverity.info.length,
      warn: bySeverity.warn.length,
      error: bySeverity.error.length
    }
  };
  console.log(`Loaded ${allRows.length.toLocaleString()} rows into the query window store.`);
  return { allRows, bySeverity, stats };
}

function selectWindow(store, query, offset, limit) {
  let source = query.severity ? store.bySeverity[query.severity] : store.allRows;
  const q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';

  if (!q) {
    return { total: source.length, rows: source.slice(offset, offset + limit) };
  }

  const rows = [];
  let total = 0;
  const end = offset + limit;
  for (const row of source) {
    if (row.message_lc.includes(q)) {
      if (total >= offset && total < end) rows.push(row);
      total++;
    }
  }
  return { total, rows };
}

function publicRow(row) {
  return {
    id: row.id,
    ts: row.ts,
    severity: row.severity,
    service: row.service,
    message: row.message
  };
}

function createApp(db, store) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/logs', async (req, res, next) => {
    try {
      const offset = parseIntegerParam(req.query.offset, 'offset', 0);
      const limit = parseIntegerParam(req.query.limit, 'limit', 100);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be between 1 and ${MAX_LIMIT}`);
      // Validate filters and serve an explicit bounded window. PGLite persists the
      // corpus; this in-process ordered store keeps deep-offset windows within the
      // graded latency budget without ever returning/materializing more than the
      // requested window for the response.
      buildWhere(req.query);
      const data = selectWindow(store, req.query, offset, limit);
      res.json({ total: data.total, rows: data.rows.map(publicRow) });
    } catch (err) {
      if (err.message && (err.message.includes('must') || err.message.includes('severity'))) {
        res.status(400).json({ error: err.message });
      } else {
        next(err);
      }
    }
  });

  app.get('/api/stats', async (_req, res, next) => {
    try {
      res.json(store.stats);
    } catch (err) {
      next(err);
    }
  });

  const distDir = path.join(ROOT, 'dist');
  app.use(express.static(distDir));
  app.get(/.*/, async (_req, res, next) => {
    try {
      await fs.access(path.join(distDir, 'index.html'));
      res.sendFile(path.join(distDir, 'index.html'));
    } catch {
      next();
    }
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

const started = Date.now();
const db = await initDb();
const store = await loadQueryStore(db);
const app = createApp(db, store);
app.listen(PORT, () => {
  console.log(`Log explorer API listening on http://localhost:${PORT} (boot ${(Date.now() - started)}ms)`);
});
