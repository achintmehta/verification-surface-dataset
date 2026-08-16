import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.PGLITE_DATA_DIR || './data/pglite';
const ROWS = 100_000;
const MAX_LIMIT = 200;
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
let statsCache = { total: 0, severities: { debug: 0, info: 0, warn: 0, error: 0 } };

await mkdir(DATA_DIR, { recursive: true });
const db = new PGlite(DATA_DIR);

const services = ['api-gateway', 'auth', 'billing', 'catalog', 'checkout', 'inventory', 'notifications', 'worker'];
const components = ['cache', 'queue', 'scheduler', 'router', 'validator', 'allocator', 'replica', 'client'];
const regions = ['us-east', 'us-west', 'eu-central', 'ap-south'];
const actions = ['accepted', 'retried', 'completed', 'deferred', 'loaded', 'evicted', 'committed', 'reconciled'];
const templates = [
  ({ service, component, region, action, i }) => `${component} ${action} request ${i % 10000} for ${service} in ${region}`,
  ({ service, component, region, action, i }) => `${service} ${component} ${action} tenant=${(i * 17) % 997} trace=tr-${String(i).padStart(6, '0')} region=${region}`,
  ({ service, component, region, action, i }) => `background ${component} ${action} batch=${i % 2048} shard=${i % 64} service=${service} zone=${region}`,
  ({ service, component, region, action, i }) => `health probe ${action} for ${service}/${component} latency=${20 + (i % 900)}ms route=/v${(i % 3) + 1}/logs`,
  ({ service, component, region, action, i }) => `request timeout budget observed ${service} ${component} attempt=${i % 5} region=${region} code=${200 + (i % 37)}`,
  ({ service, component, region, action, i }) => `customer workflow ${action} account=acct-${(i * 31) % 5000} service=${service} component=${component}`,
];

function severityFor(i) {
  const n = i % 100;
  if (n < 60) return 'debug';
  if (n < 85) return 'info';
  if (n < 95) return 'warn';
  return 'error';
}

function rowFor(i) {
  const service = services[i % services.length];
  const component = components[(i * 7) % components.length];
  const region = regions[(i * 11) % regions.length];
  const action = actions[(i * 13) % actions.length];
  const start = Date.UTC(2024, 0, 1, 0, 0, 0);
  const spanMs = 30 * 24 * 60 * 60 * 1000;
  const ts = new Date(start + Math.floor((i * spanMs) / ROWS)).toISOString();
  let message = templates[i % templates.length]({ service, component, region, action, i });
  // Deterministic terms with different selectivity for substring testing.
  if (i % 10 === 0) message += ' timeout common-path';
  if (i % 137 === 0) message += ` payment-needle selective-${i % 913}`;
  if (i % 4096 === 0) message += ' rare-coldstart-marker';
  if (severityFor(i) === 'error') message += ` error-code=E${1000 + (i % 300)}`;
  return [i + 1, ts, severityFor(i), service, message];
}

function quoteLike(value) {
  return `%${value.toLowerCase().replace(/[\\%_]/g, m => `\\${m}`)}%`;
}

async function initDb() {
  console.time('database ready');
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const count = Number(countResult.rows[0]?.count || 0);
  if (count !== ROWS) {
    console.log(`Seeding deterministic log corpus (${count} existing rows, target ${ROWS})...`);
    await db.query('BEGIN');
    try {
      await db.query('TRUNCATE logs');
      const batchSize = 1000;
      for (let start = 0; start < ROWS; start += batchSize) {
        const values = [];
        const params = [];
        let p = 1;
        for (let i = start; i < Math.min(start + batchSize, ROWS); i++) {
          values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
          params.push(...rowFor(i));
        }
        await db.query(
          `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')}`,
          params,
        );
      }
      await db.query('COMMIT');
      console.log(`Seeded ${ROWS} rows.`);
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  } else {
    console.log(`Existing corpus found (${ROWS} rows); skipping seed.`);
  }

  await db.query('CREATE INDEX IF NOT EXISTS logs_ts_desc_idx ON logs (ts DESC, id DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS logs_severity_ts_desc_idx ON logs (severity, ts DESC, id DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS logs_lower_message_idx ON logs ((LOWER(message)))');
  // Keep the embedded planner informed after bulk seed/index creation.
  await db.query('ANALYZE logs');
  const statRows = await db.query(`
    SELECT severity, COUNT(*)::int AS count
    FROM logs
    GROUP BY severity
  `);
  const severities = { debug: 0, info: 0, warn: 0, error: 0 };
  let total = 0;
  for (const row of statRows.rows) {
    severities[row.severity] = Number(row.count);
    total += Number(row.count);
  }
  statsCache = { total, severities };
  console.timeEnd('database ready');
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
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
    return null;
  }
  const severity = req.query.severity ? String(req.query.severity).toLowerCase() : '';
  if (severity && !SEVERITIES.has(severity)) {
    res.status(400).json({ error: 'unknown severity' });
    return null;
  }
  const q = req.query.q == null ? '' : String(req.query.q).trim();
  if (q.length > 200) {
    res.status(400).json({ error: 'q must be 200 characters or fewer' });
    return null;
  }
  return { offset, limit, severity, q };
}

function whereFor({ severity, q }, params) {
  const clauses = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push(quoteLike(q));
    clauses.push(`LOWER(message) LIKE $${params.length} ESCAPE '\\'`);
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

await initDb();

const app = express();
app.use(cors());
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
app.use('/src', express.static(path.join(rootDir, 'src')));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/stats', async (_req, res) => {
  res.json(statsCache);
});

app.get('/api/logs', async (req, res, next) => {
  try {
    const parsed = parseLogsQuery(req, res);
    if (!parsed) return;
    const params = [];
    const where = whereFor(parsed, params);
    const countParams = [...params];
    const rowParams = [...params, parsed.limit, parsed.offset];
    const limitIndex = params.length + 1;
    const offsetIndex = params.length + 2;

    const totalPromise = parsed.q
      ? db.query(`SELECT COUNT(*)::int AS total FROM logs ${where}`, countParams)
      : Promise.resolve({ rows: [{ total: parsed.severity ? statsCache.severities[parsed.severity] : statsCache.total }] });

    const [totalResult, rowsResult] = await Promise.all([
      totalPromise,
      db.query(
        `SELECT id, ts, severity, service, message
         FROM logs
         ${where}
         ORDER BY ts DESC, id DESC
         LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
        rowParams,
      ),
    ]);

    res.json({ total: Number(totalResult.rows[0]?.total || 0), rows: rowsResult.rows });
  } catch (err) {
    next(err);
  }
});

app.get('/', (_req, res) => res.sendFile(path.join(rootDir, 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`Log explorer API listening on http://localhost:${PORT}`);
});
