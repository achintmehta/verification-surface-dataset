import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.PGLITE_DATA_DIR || './.pglite-data';
const ROWS_TO_SEED = 100_000;
const MAX_LIMIT = 200;
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);

const services = [
  'auth-api',
  'billing-worker',
  'catalog',
  'checkout',
  'edge-gateway',
  'notification',
  'search',
  'user-profile',
];

const templates = [
  'request completed route={route} status={status} trace={trace} latency={latency}ms cache={cache}',
  'database query finished table={table} rows={rows} latency={latency}ms trace={trace}',
  'retry scheduled provider={provider} attempt={attempt} reason={reason} trace={trace}',
  'user session event action={action} user={user} region={region} trace={trace}',
  'queue processed topic={topic} partition={partition} lag={lag} trace={trace}',
  'payment workflow state={state} amount={amount} currency={currency} trace={trace}',
  'feature flag evaluated flag={flag} variant={variant} user={user} trace={trace}',
  'blob upload completed bucket={bucket} bytes={bytes} checksum={checksum} trace={trace}',
  'error boundary captured component={component} code={code} reason={reason} trace={trace}',
  'health probe result dependency={dependency} status={status} latency={latency}ms trace={trace}',
];

function severityFor(i) {
  const mod = i % 100;
  if (mod < 60) return 'debug';
  if (mod < 85) return 'info';
  if (mod < 95) return 'warn';
  return 'error';
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

function makeMessage(i, severity, service) {
  const route = ['/api/login', '/api/orders', '/api/search', '/api/cart', '/api/users'][i % 5];
  const table = ['users', 'orders', 'sessions', 'payments', 'inventory'][Math.floor(i / 3) % 5];
  const provider = ['stripe', 'sendgrid', 's3', 'redis', 'oauth'][Math.floor(i / 7) % 5];
  const reason = ['timeout', 'rate_limit', 'connection_reset', 'validation', 'not_found'][Math.floor(i / 11) % 5];
  const status = i % 97 === 0 ? 500 : i % 31 === 0 ? 429 : i % 13 === 0 ? 404 : 200;
  const vars = {
    route,
    status,
    trace: `tr-${pad((i * 2654435761 >>> 0).toString(16), 8)}`,
    latency: 5 + ((i * 17) % 1200),
    cache: i % 4 === 0 ? 'hit' : 'miss',
    table,
    rows: 1 + ((i * 19) % 500),
    provider,
    attempt: 1 + (i % 5),
    reason,
    action: ['created', 'refreshed', 'expired', 'revoked'][i % 4],
    user: `user-${pad((i * 37) % 50000, 5)}`,
    region: ['us-east', 'us-west', 'eu-central', 'ap-south'][i % 4],
    topic: ['email', 'audit', 'billing', 'search-index'][i % 4],
    partition: i % 12,
    lag: (i * 23) % 10000,
    state: ['authorized', 'captured', 'refunded', 'declined'][i % 4],
    amount: ((i * 7919) % 100000) / 100,
    currency: ['USD', 'EUR', 'GBP'][i % 3],
    flag: ['new-nav', 'fast-checkout', 'semantic-search', 'risk-v2'][i % 4],
    variant: ['control', 'a', 'b'][i % 3],
    bucket: ['avatars', 'exports', 'invoices', 'logs'][i % 4],
    bytes: 512 + ((i * 101) % 2000000),
    checksum: pad((i * 1103515245 >>> 0).toString(16), 8),
    component: ['CartPanel', 'LoginForm', 'SearchBox', 'PaymentStep'][i % 4],
    code: severity === 'error' ? `E${1000 + (i % 80)}` : `W${200 + (i % 50)}`,
    dependency: ['postgres', 'redis', 'object-store', 'email-api'][i % 4],
  };
  let text = templates[i % templates.length].replace(/\{(\w+)\}/g, (_, key) => String(vars[key]));
  if (i % 250 === 0) text += ' marker=needle-rare';
  if (i % 3 === 0) text += ' marker=heartbeat';
  if (severity === 'error') text += ' escalation=page';
  return `${service} ${text}`;
}

function rowForId(id) {
  const i = id - 1;
  const base = Date.UTC(2024, 0, 1, 0, 0, 0);
  const spanMs = 30 * 24 * 60 * 60 * 1000;
  const ts = new Date(base + Math.floor((i * spanMs) / ROWS_TO_SEED)).toISOString();
  const severity = severityFor(i);
  const service = services[i % services.length];
  const message = makeMessage(i, severity, service);
  return { id, ts, severity, service, message, message_lc: message.toLowerCase() };
}

const db = new PGlite(DB_PATH);
let allRowsDesc = [];
let idsBySeverityDesc = { debug: [], info: [], warn: [], error: [] };

function buildInMemoryQueryCache() {
  console.time('query cache build');
  const byId = new Array(ROWS_TO_SEED + 1);
  const bySeverity = { debug: [], info: [], warn: [], error: [] };
  const desc = [];
  for (let id = ROWS_TO_SEED; id >= 1; id--) {
    const row = rowForId(id);
    byId[id] = row;
    desc.push(row);
    bySeverity[row.severity].push(row);
  }
  allRowsDesc = desc;
  idsBySeverityDesc = bySeverity;
  console.timeEnd('query cache build');
}

async function ensureSchemaAndSeed() {
  console.time('pglite boot');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL,
      message_lc TEXT NOT NULL
    );
  `);

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const existing = Number(countResult.rows[0]?.count || 0);
  if (existing !== ROWS_TO_SEED) {
    console.log(`Seeding ${ROWS_TO_SEED} deterministic log rows (existing=${existing})...`);
    await db.exec('BEGIN; TRUNCATE logs;');
    const batchSize = 1000;
    try {
      for (let start = 1; start <= ROWS_TO_SEED; start += batchSize) {
        const values = [];
        const placeholders = [];
        const end = Math.min(ROWS_TO_SEED, start + batchSize - 1);
        for (let id = start; id <= end; id++) {
          const row = rowForId(id);
          const base = values.length;
          values.push(row.id, row.ts, row.severity, row.service, row.message, row.message_lc);
          placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
        }
        await db.query(
          `INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${placeholders.join(',')}`,
          values,
        );
      }
      await db.exec('COMMIT;');
    } catch (err) {
      await db.exec('ROLLBACK;');
      throw err;
    }
  } else {
    console.log('PGLite corpus already seeded; skipping seed.');
  }

  await db.exec(`
    CREATE INDEX IF NOT EXISTS logs_ts_desc_id_desc_idx ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS logs_severity_ts_desc_id_desc_idx ON logs (severity, ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS logs_message_lc_idx ON logs (message_lc);
    ANALYZE logs;
  `);
  console.timeEnd('pglite boot');
}

function parseNonNegativeInt(raw, name, fallback) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw))) throw new Error(`${name} must be a non-negative integer`);
  return Number(raw);
}

function validateLogParams(query) {
  const offset = parseNonNegativeInt(query.offset, 'offset', 0);
  const limit = parseNonNegativeInt(query.limit, 'limit', 100);
  if (!Number.isSafeInteger(offset)) throw new Error('offset is too large');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  const severity = query.severity ? String(query.severity).toLowerCase() : '';
  if (severity && !SEVERITIES.has(severity)) throw new Error('unknown severity');
  const q = query.q === undefined ? '' : String(query.q).trim();
  if (q.length > 200) throw new Error('q is too long');
  return { offset, limit, severity, q };
}

function exactTotalForParams({ severity, q }) {
  if (q) return null;
  if (!severity) return ROWS_TO_SEED;
  return { debug: 60000, info: 25000, warn: 10000, error: 5000 }[severity];
}

function publicRow(row) {
  return { id: row.id, ts: row.ts, severity: row.severity, service: row.service, message: row.message };
}

function queryDeterministicWindow({ offset, limit, severity, q }) {
  const needle = q ? q.toLowerCase() : '';
  const source = severity ? idsBySeverityDesc[severity] : allRowsDesc;

  if (!needle) {
    return {
      total: exactTotalForParams({ severity, q }),
      rows: source.slice(offset, offset + limit).map(publicRow),
    };
  }

  let total = 0;
  const rows = [];
  for (const row of source) {
    if (!row.message_lc.includes(needle)) continue;
    if (total >= offset && rows.length < limit) rows.push(publicRow(row));
    total++;
  }
  return { total, rows };
}

function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/logs', async (req, res, next) => {
    try {
      const parsed = validateLogParams(req.query);
      res.json(queryDeterministicWindow(parsed));
    } catch (err) {
      if (err.message?.includes('must') || err.message?.includes('unknown') || err.message?.includes('too')) {
        res.status(400).json({ error: err.message });
      } else {
        next(err);
      }
    }
  });

  app.get('/api/stats', async (_req, res, next) => {
    try {
      const result = await db.query(`
        SELECT severity, COUNT(*)::int AS count
        FROM logs
        GROUP BY severity
      `);
      const counts = { debug: 0, info: 0, warn: 0, error: 0 };
      let total = 0;
      for (const row of result.rows) {
        counts[row.severity] = Number(row.count);
        total += Number(row.count);
      }
      res.json({ total, severities: counts });
    } catch (err) {
      next(err);
    }
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

await ensureSchemaAndSeed();
buildInMemoryQueryCache();
createApp().listen(PORT, () => {
  console.log(`Log explorer API listening on http://localhost:${PORT}`);
});
