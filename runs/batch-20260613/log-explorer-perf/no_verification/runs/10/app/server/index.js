import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.PGLITE_DATA_DIR || './.pglite';
const ROW_COUNT = 100_000;
const MAX_LIMIT = 200;
const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const SERVICES = ['auth', 'billing', 'checkout', 'catalog', 'search', 'orders', 'notifications', 'gateway'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];

let db;
let allRows = [];
let rowsBySeverity = new Map();
let statsCache = null;

function severityForIndex(i) {
  const bucket = i % 100;
  if (bucket < 60) return 'debug';
  if (bucket < 85) return 'info';
  if (bucket < 95) return 'warn';
  return 'error';
}

function pad(n, size = 5) {
  return String(n).padStart(size, '0');
}

function deterministicMessage(i, severity, service) {
  const user = `user-${(i * 17) % 997}`;
  const trace = `trace-${pad((i * 7919) % 100000, 5)}`;
  const shard = `shard-${i % 32}`;
  const req = `req-${pad(i, 6)}`;
  const common = i % 3 === 0 ? 'timeout' : i % 3 === 1 ? 'cache' : 'connection';
  const rare = i % 4096 === 777 ? ' needle-777' : '';
  const medium = i % 97 === 0 ? ' payment-declined' : '';

  switch (i % 10) {
    case 0:
      return `${service} ${severity} ${common} while processing ${req} for ${user} on ${shard} ${trace}${rare}`;
    case 1:
      return `${service} completed request ${req}; cache lookup for ${user} returned ${i % 2 ? 'hit' : 'miss'} ${trace}`;
    case 2:
      return `${service} database query latency ${(i * 13) % 1200}ms for ${user} ${common} ${trace}${medium}`;
    case 3:
      return `${service} retry scheduled after upstream ${common} for ${req} ${trace}`;
    case 4:
      return `${service} authorization decision ${i % 4 === 0 ? 'allow' : 'deny'} for ${user} ${trace}`;
    case 5:
      return `${service} queue depth ${(i * 29) % 5000} on ${shard}; worker heartbeat normal ${trace}${rare}`;
    case 6:
      return `${service} wrote audit event for ${req}; payload bytes ${(i * 37) % 8192} ${trace}`;
    case 7:
      return `${service} upstream response status ${i % 11 === 0 ? 503 : 200} for ${req} ${common} ${trace}`;
    case 8:
      return `${service} configuration refresh version v${(i % 64) + 1} applied to ${shard} ${trace}`;
    default:
      return `${service} session cleanup removed ${(i * 7) % 300} records for ${user} ${trace}${medium}`;
  }
}

async function initializeSchema() {
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
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id DESC);');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id DESC);');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_message_lc ON logs (message_lc);');
}

async function seedIfNeeded() {
  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM logs;');
  const existing = Number(countResult.rows?.[0]?.count || 0);
  if (existing === ROW_COUNT) {
    console.log(`Seed skipped; ${existing} log rows already present.`);
    return;
  }

  console.log(`Seeding deterministic corpus (${ROW_COUNT} rows)...`);
  const start = Date.now();
  await db.query('TRUNCATE TABLE logs;');
  await db.query('BEGIN;');
  try {
    const batchSize = 1000;
    const base = Date.UTC(2025, 0, 31, 23, 59, 59, 0);
    const spanMs = 30 * 24 * 60 * 60 * 1000;
    const stepMs = Math.floor(spanMs / ROW_COUNT);

    for (let startIdx = 0; startIdx < ROW_COUNT; startIdx += batchSize) {
      const end = Math.min(startIdx + batchSize, ROW_COUNT);
      const values = [];
      const placeholders = [];
      let p = 1;
      for (let i = startIdx; i < end; i++) {
        const id = i + 1;
        const ts = new Date(base - i * stepMs).toISOString();
        const severity = severityForIndex(i);
        const service = SERVICES[i % SERVICES.length];
        const message = deterministicMessage(i, severity, service);
        placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
        values.push(id, ts, severity, service, message, message.toLowerCase());
      }
      await db.query(
        `INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${placeholders.join(',')};`,
        values
      );
    }
    await db.query('COMMIT;');
  } catch (err) {
    await db.query('ROLLBACK;');
    throw err;
  }
  console.log(`Seed complete in ${Date.now() - start}ms.`);
}

async function loadCache() {
  const start = Date.now();
  const result = await db.query('SELECT id, ts, severity, service, message, message_lc FROM logs ORDER BY ts DESC, id DESC;');
  allRows = result.rows.map((row) => ({
    id: Number(row.id),
    ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
    severity: row.severity,
    service: row.service,
    message: row.message,
    message_lc: row.message_lc,
  }));

  rowsBySeverity = new Map(SEVERITIES.map((s) => [s, []]));
  for (const row of allRows) rowsBySeverity.get(row.severity).push(row);

  const bySeverity = {};
  for (const s of SEVERITIES) bySeverity[s] = rowsBySeverity.get(s).length;
  statsCache = { total: allRows.length, severities: bySeverity };
  console.log(`Loaded ${allRows.length} log rows into query cache in ${Date.now() - start}ms.`);
}

function parseLogsQuery(req, res) {
  const offsetRaw = req.query.offset ?? '0';
  const limitRaw = req.query.limit ?? '100';
  if (!/^\d+$/.test(String(offsetRaw))) {
    res.status(400).json({ error: 'offset must be a non-negative integer' });
    return null;
  }
  if (!/^\d+$/.test(String(limitRaw))) {
    res.status(400).json({ error: 'limit must be a positive integer no greater than 200' });
    return null;
  }
  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    res.status(400).json({ error: 'offset must be a non-negative integer' });
    return null;
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    res.status(400).json({ error: 'limit must be between 1 and 200' });
    return null;
  }

  const severity = req.query.severity ? String(req.query.severity).toLowerCase() : '';
  if (severity && !VALID_SEVERITIES.has(severity)) {
    res.status(400).json({ error: 'unknown severity' });
    return null;
  }
  const q = req.query.q ? String(req.query.q).trim().toLowerCase() : '';
  return { offset, limit, severity, q };
}

function stripInternal(row) {
  return {
    id: row.id,
    ts: row.ts,
    severity: row.severity,
    service: row.service,
    message: row.message,
  };
}

function queryRows({ offset, limit, severity, q }) {
  const source = severity ? rowsBySeverity.get(severity) || [] : allRows;
  if (!q) {
    return { total: source.length, rows: source.slice(offset, offset + limit).map(stripInternal) };
  }

  const rows = [];
  let total = 0;
  const endExclusive = offset + limit;
  for (const row of source) {
    if (row.message_lc.includes(q)) {
      if (total >= offset && total < endExclusive) rows.push(stripInternal(row));
      total++;
    }
  }
  return { total, rows };
}

async function main() {
  const bootStart = Date.now();
  db = new PGlite(DB_PATH);
  await initializeSchema();
  await seedIfNeeded();
  await loadCache();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/stats', (_req, res) => {
    res.json(statsCache);
  });

  app.get('/api/logs', (req, res) => {
    const parsed = parseLogsQuery(req, res);
    if (!parsed) return;
    const payload = queryRows(parsed);
    res.set('Cache-Control', 'no-store');
    res.json(payload);
  });

  app.listen(PORT, () => {
    console.log(`Log explorer API listening on http://localhost:${PORT} (boot ${Date.now() - bootStart}ms)`);
  });
}

main().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
