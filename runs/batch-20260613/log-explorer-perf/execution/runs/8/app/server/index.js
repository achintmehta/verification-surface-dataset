import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(ROOT, 'pglite-data');
const PORT = Number(process.env.PORT || 3000);
const ROW_COUNT = 100_000;
const MAX_LIMIT = 200;
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const SERVICES = [
  'auth-api',
  'billing-worker',
  'checkout',
  'edge-gateway',
  'inventory',
  'notifications',
  'search',
  'user-profile'
];

const messageTemplates = [
  (i, service) => `request completed route=/api/v1/items status=200 trace=${trace(i)} service=${service} cache=hit`,
  (i, service) => `request completed route=/api/v1/users status=200 trace=${trace(i)} service=${service} cache=miss`,
  (i, service) => `database query finished duration=${(i % 91) + 3}ms shard=${i % 12} rows=${(i * 7) % 250}`,
  (i, service) => `queue job processed name=${jobName(i)} latency=${(i % 700) + 20}ms worker=${service}`,
  (i) => `retry scheduled upstream=${upstream(i)} attempt=${(i % 4) + 1} reason=timeout trace=${trace(i)}`,
  (i) => `validation failed field=${fieldName(i)} code=${i % 17} client=web trace=${trace(i)}`,
  (i) => `cache refresh complete region=${region(i)} keys=${(i * 13) % 4000} common heartbeat`,
  (i, service) => `background heartbeat service=${service} node=node-${i % 32} common healthy`,
  (i) => `payment authorization declined provider=${provider(i)} amount=${((i % 5000) / 100).toFixed(2)} trace=${trace(i)}`,
  (i) => `feature flag evaluated flag=${flagName(i)} variant=${i % 3} tenant=tenant-${i % 128}`,
  (i) => `rare mercury anomaly detected component=${component(i)} token=mercury-${i}`, // selective term
  (i) => `security audit event action=${action(i)} actor=user-${i % 5000} ip=10.${i % 255}.${(i * 3) % 255}.${(i * 7) % 255}`
];

function trace(i) {
  return (0x10000000 + ((i * 2654435761) >>> 0)).toString(16).slice(0, 8);
}
function jobName(i) { return ['email-digest', 'invoice-sync', 'thumbnail', 'export', 'webhook'][i % 5]; }
function upstream(i) { return ['stripe', 'github', 's3', 'smtp', 'identity'][i % 5]; }
function fieldName(i) { return ['email', 'password', 'address', 'sku', 'quantity', 'phone'][i % 6]; }
function region(i) { return ['us-east', 'us-west', 'eu-central', 'ap-south'][i % 4]; }
function provider(i) { return ['visa', 'mastercard', 'amex', 'adyen'][i % 4]; }
function flagName(i) { return ['new_nav', 'fast_pay', 'search_v2', 'dark_mode', 'risk_rules'][i % 5]; }
function component(i) { return ['scheduler', 'replicator', 'allocator', 'parser'][i % 4]; }
function action(i) { return ['login', 'logout', 'token_refresh', 'role_change', 'api_key_create'][i % 5]; }
function severityFor(i) {
  const m = i % 100;
  if (m < 60) return 'info';
  if (m < 85) return 'debug';
  if (m < 95) return 'warn';
  return 'error';
}
function serviceFor(i) { return SERVICES[i % SERVICES.length]; }
function timestampFor(i) {
  const start = Date.UTC(2025, 0, 1, 0, 0, 0);
  const spanMs = 30 * 24 * 60 * 60 * 1000;
  const ts = start + Math.floor(((i - 1) / (ROW_COUNT - 1)) * spanMs);
  return new Date(ts).toISOString();
}
function messageFor(i, service) {
  // Put rare/selective messages at a predictable low frequency; most rows include common words.
  if (i % 997 === 0) return messageTemplates[10](i, service);
  const templateIndex = i % 11;
  return messageTemplates[templateIndex === 10 ? 11 : templateIndex](i, service);
}

await fs.mkdir(DATA_DIR, { recursive: true });
const db = new PGlite(DATA_DIR);

async function initDb() {
  const t0 = Date.now();
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL,
      message_lc TEXT NOT NULL
    );
  `);

  const countRes = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const existing = Number(countRes.rows[0]?.count || 0);
  if (existing !== ROW_COUNT) {
    console.log(`[seed] found ${existing} rows; rebuilding deterministic ${ROW_COUNT}-row corpus`);
    await db.query('BEGIN');
    try {
      await db.query('TRUNCATE logs');
      const batchSize = 1000;
      for (let start = 1; start <= ROW_COUNT; start += batchSize) {
        const values = [];
        const params = [];
        let p = 1;
        const end = Math.min(start + batchSize - 1, ROW_COUNT);
        for (let id = start; id <= end; id++) {
          const service = serviceFor(id);
          const severity = severityFor(id);
          const msg = messageFor(id, service);
          values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
          params.push(id, timestampFor(id), severity, service, msg, msg.toLowerCase());
        }
        await db.query(
          `INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${values.join(',')}`,
          params
        );
        if ((end % 10000) === 0) console.log(`[seed] inserted ${end}/${ROW_COUNT}`);
      }
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  } else {
    console.log(`[seed] ${ROW_COUNT} rows already present; skipping seed`);
  }

  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_message_lc ON logs (message_lc)');
  await db.query('ANALYZE logs');
  console.log(`[init] database ready in ${Date.now() - t0}ms`);
}

function parseLogsQuery(query) {
  const offset = query.offset == null || query.offset === '' ? 0 : Number(query.offset);
  const limit = query.limit == null || query.limit === '' ? 100 : Number(query.limit);
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);

  const severity = query.severity == null || query.severity === '' ? null : String(query.severity).toLowerCase();
  if (severity && !SEVERITIES.has(severity)) throw new Error('unknown severity');

  const q = query.q == null ? '' : String(query.q).trim().toLowerCase();
  if (q.length > 200) throw new Error('q must be at most 200 characters');
  return { offset, limit, severity, q };
}

function whereClause({ severity, q }) {
  const parts = [];
  const params = [];
  if (severity) {
    params.push(severity);
    parts.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
    parts.push(`message_lc LIKE $${params.length} ESCAPE '\\'`);
  }
  return {
    sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '',
    params
  };
}

function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/logs', async (req, res, next) => {
    try {
      const parsed = parseLogsQuery(req.query);
      const where = whereClause(parsed);
      const countSql = `SELECT COUNT(*)::int AS total FROM logs ${where.sql}`;
      const dataParams = [...where.params, parsed.limit, parsed.offset];
      const dataSql = `
        SELECT id, ts, severity, service, message
        FROM logs
        ${where.sql}
        ORDER BY ts DESC, id DESC
        LIMIT $${where.params.length + 1} OFFSET $${where.params.length + 2}
      `;
      const [countRes, rowsRes] = await Promise.all([
        db.query(countSql, where.params),
        db.query(dataSql, dataParams)
      ]);
      res.json({ total: Number(countRes.rows[0]?.total || 0), rows: rowsRes.rows });
    } catch (err) {
      if (err.message?.includes('offset') || err.message?.includes('limit') || err.message?.includes('severity') || err.message?.includes('q ')) {
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
      const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
      let total = 0;
      for (const row of result.rows) {
        bySeverity[row.severity] = Number(row.count);
        total += Number(row.count);
      }
      res.json({ total, severities: bySeverity });
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

await initDb();
createApp().listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
