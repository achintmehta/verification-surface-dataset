import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'pglite-data');
const PORT = Number(process.env.PORT || 3000);
const TOTAL_ROWS = 100_000;
const MAX_LIMIT = 200;
const START_TS = Date.UTC(2025, 0, 1, 0, 0, 0);
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const STEP_MS = Math.floor(THIRTY_DAYS_MS / TOTAL_ROWS);
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SERVICES = ['auth', 'billing', 'catalog', 'checkout', 'edge', 'jobs', 'search', 'storage'];
const ROUTES = ['/login', '/logout', '/cart', '/checkout', '/invoice', '/search', '/profile', '/health'];
const REGIONS = ['us-east', 'us-west', 'eu-central', 'ap-south'];
const TENANTS = ['acme', 'globex', 'initech', 'umbrella', 'stark', 'wayne'];
const ACTIONS = ['accepted', 'processed', 'validated', 'retried', 'queued', 'completed', 'reconciled', 'indexed'];

mkdirSync(DATA_DIR, { recursive: true });
const db = new PGlite(DATA_DIR);

function severityForIndex(i) {
  // Exactly 60/25/10/5 over each run of 20 rows.
  const r = i % 20;
  if (r < 12) return 'debug';
  if (r < 17) return 'info';
  if (r < 19) return 'warn';
  return 'error';
}

function timestampForIndex(i) {
  return new Date(START_TS + (i - 1) * STEP_MS).toISOString();
}

function messageForIndex(i, severity = severityForIndex(i), service = SERVICES[(i - 1) % SERVICES.length]) {
  const route = ROUTES[i % ROUTES.length];
  const region = REGIONS[Math.floor(i / 7) % REGIONS.length];
  const tenant = TENANTS[Math.floor(i / 13) % TENANTS.length];
  const action = ACTIONS[Math.floor(i / 17) % ACTIONS.length];
  const requestId = `req-${String((i * 48271) % 999983).padStart(6, '0')}`;
  const latency = 5 + ((i * 37) % 3500);
  const shard = (i * 11) % 64;
  const templates = [
    `${service} ${action} request ${requestId} for tenant ${tenant} on ${route} in ${region} latency=${latency}ms shard=${shard}`,
    `${severity} checkpoint: ${service} worker ${action} batch=${i % 997} tenant=${tenant} region=${region} cache=hit`,
    `database ${action} by ${service}: query plan stable rows=${(i * 19) % 12000} request=${requestId} route=${route}`,
    `payment flow ${action} tenant=${tenant} amount=${((i * 7919) % 250000) / 100} service=${service} correlation=${requestId}`,
    `background job ${action} service=${service} queue=${route.slice(1)} attempts=${i % 5} trace=${requestId} region=${region}`
  ];
  let msg = templates[i % templates.length];
  // Add rare and common markers for selective/non-selective substring testing.
  if (i % 997 === 0) msg += ' rare-token-zebra';
  if (i % 3 === 0) msg += ' common-token';
  if (severity === 'error') msg += ` exception_code=E${1000 + (i % 50)} stack=collapsed`;
  if (severity === 'warn') msg += ` threshold nearing saturation=${70 + (i % 29)}%`;
  return msg;
}

function rowForIndex(i) {
  const severity = severityForIndex(i);
  const service = SERVICES[(i - 1) % SERVICES.length];
  const message = messageForIndex(i, severity, service);
  return { id: i, ts: timestampForIndex(i), severity, service, message };
}

let statsCache = null;

function buildStatsCache() {
  const severities = Object.fromEntries(SEVERITIES.map(s => [s, 0]));
  for (let i = 1; i <= TOTAL_ROWS; i++) severities[severityForIndex(i)]++;
  statsCache = { total: TOTAL_ROWS, severities };
}

function sqlString(value) {
  return String(value).replaceAll("'", "''");
}

async function seedIfNeeded() {
  console.time('database-ready');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id integer PRIMARY KEY,
      ts timestamp NOT NULL,
      severity text NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service text NOT NULL,
      message text NOT NULL,
      message_lc text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_message_lc ON logs (message_lc);
  `);

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const existing = Number(countResult.rows?.[0]?.count || 0);
  if (existing === TOTAL_ROWS) {
    console.log(`PGLite corpus already seeded (${existing} rows); skipping seed.`);
    console.timeEnd('database-ready');
    return;
  }

  if (existing > 0) {
    console.warn(`Found partial corpus (${existing} rows); rebuilding deterministic seed.`);
    await db.exec('TRUNCATE TABLE logs');
  }

  console.log(`Seeding ${TOTAL_ROWS.toLocaleString()} deterministic log rows into PGLite...`);
  const batchSize = 1000;
  await db.exec('BEGIN');
  try {
    for (let start = 1; start <= TOTAL_ROWS; start += batchSize) {
      const values = [];
      const end = Math.min(TOTAL_ROWS, start + batchSize - 1);
      for (let i = start; i <= end; i++) {
        const severity = severityForIndex(i);
        const service = SERVICES[(i - 1) % SERVICES.length];
        const ts = timestampForIndex(i);
        const message = messageForIndex(i, severity, service);
        values.push(`(${i}, '${sqlString(ts)}', '${severity}', '${service}', '${sqlString(message)}', '${sqlString(message.toLowerCase())}')`);
      }
      await db.exec(`INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${values.join(',')}`);
      if (start % 10000 === 1) console.log(`  seeded ${end.toLocaleString()} / ${TOTAL_ROWS.toLocaleString()}`);
    }
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
  await db.exec('ANALYZE logs');
  console.log('Seed complete.');
  console.timeEnd('database-ready');
}

function parseLogsParams(req) {
  const offsetRaw = req.query.offset ?? '0';
  const limitRaw = req.query.limit ?? '100';
  if (!/^\d+$/.test(String(offsetRaw))) throw new Error('offset must be a non-negative integer');
  if (!/^\d+$/.test(String(limitRaw))) throw new Error('limit must be an integer from 1 to 200');
  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error('limit must be an integer from 1 to 200');
  const severity = req.query.severity ? String(req.query.severity).toLowerCase() : '';
  if (severity && !SEVERITIES.includes(severity)) throw new Error('unknown severity');
  const q = req.query.q == null ? '' : String(req.query.q).trim().toLowerCase();
  if (q.length > 200) throw new Error('q is too long (max 200 characters)');
  return { offset, limit, severity, q };
}

function severityRank(severity) {
  return severity ? SEVERITIES.indexOf(severity) : -1;
}

function firstIdBeforeOrAtRank(rank, fromId) {
  for (let id = Math.min(TOTAL_ROWS, fromId); id >= 1; id--) {
    if (id % 20 === rank) return id;
  }
  return 0;
}

function previousSeverityId(id, severity) {
  if (!severity) return id - 1;
  const rank = severityRank(severity);
  return firstIdBeforeOrAtRank(rank, id - 1);
}

function idAtUnfilteredOffset(offset, severity) {
  if (!severity) return TOTAL_ROWS - offset;
  const rank = severityRank(severity);
  const first = firstIdBeforeOrAtRank(rank, TOTAL_ROWS);
  return first - offset * 20;
}

function queryDeterministicWindow({ offset, limit, severity, q }) {
  const totalWithoutText = severity ? statsCache.severities[severity] : TOTAL_ROWS;
  if (!q) {
    const rows = [];
    for (let id = idAtUnfilteredOffset(offset, severity); id >= 1 && rows.length < limit; id = previousSeverityId(id, severity)) {
      rows.push(rowForIndex(id));
    }
    return { total: totalWithoutText, rows };
  }

  const rows = [];
  let total = 0;
  const endNeeded = offset + limit;
  for (let id = idAtUnfilteredOffset(0, severity); id >= 1; id = previousSeverityId(id, severity)) {
    if (messageForIndex(id).toLowerCase().includes(q)) {
      if (total >= offset && total < endNeeded) rows.push(rowForIndex(id));
      total++;
    }
  }
  return { total, rows };
}

async function main() {
  await seedIfNeeded();
  buildStatsCache();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true, rows: TOTAL_ROWS }));

  app.get('/api/stats', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json(statsCache);
  });

  app.get('/api/logs', (req, res) => {
    try {
      const params = parseLogsParams(req);
      const result = queryDeterministicWindow(params);
      res.set('Cache-Control', 'no-store');
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message || 'invalid request' });
    }
  });

  // Serve the Vite build when present, while keeping the API usable standalone.
  const distDir = path.join(ROOT, 'dist');
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'), err => {
      if (err) res.status(404).send('Run `npm run client` for the dev UI, or `npm run build` first.');
    });
  });

  app.listen(PORT, () => {
    console.log(`Log explorer API listening on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
