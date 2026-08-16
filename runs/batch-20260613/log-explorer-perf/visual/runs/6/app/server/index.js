import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const ROW_COUNT = 100_000;
const MAX_LIMIT = 200;
const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const SERVICES = ['api-gateway', 'auth', 'billing', 'catalog', 'checkout', 'inventory', 'notifications', 'search'];

let logs = [];
let lowerMessages = [];
let bySeverity = new Map();
let stats = { total: 0, severities: {} };

const db = new PGlite(path.join(ROOT, 'pglite-data'));

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function severityFor(i) {
  const n = i % 100;
  if (n < 60) return 'debug';
  if (n < 85) return 'info';
  if (n < 95) return 'warn';
  return 'error';
}

function messageFor(i, severity, service) {
  const user = (i * 7919) % 50000;
  const request = (i * 104729).toString(36);
  const latency = 5 + ((i * 37) % 2500);
  const shard = (i * 17) % 64;
  const route = ['/v1/login', '/v1/orders', '/v1/search', '/v1/cart', '/v1/profile', '/v1/payments'][i % 6];
  const common = [
    `request ${request} completed route=${route} user=${user} latency=${latency}ms shard=${shard}`,
    `cache lookup ${i % 3 === 0 ? 'hit' : 'miss'} key=session:${user % 1000} request=${request} latency=${latency}ms`,
    `database query finished table=${['users', 'orders', 'items', 'sessions'][i % 4]} rows=${(i * 13) % 200} latency=${latency}ms`,
    `worker heartbeat healthy queue=${['email', 'billing', 'indexing', 'reconcile'][i % 4]} depth=${(i * 19) % 1000}`
  ];
  const warn = [
    `slow request warning route=${route} request=${request} latency=${latency + 1500}ms`,
    `retry scheduled for upstream service=${service} attempt=${(i % 4) + 1} request=${request}`,
    `rate limit nearing threshold tenant=${user % 200} route=${route}`
  ];
  const err = [
    `timeout contacting upstream dependency request=${request} route=${route} latency=${latency + 3000}ms`,
    `payment authorization failed code=${['DECLINED', 'EXPIRED', 'FRAUD_CHECK'][i % 3]} user=${user} request=${request}`,
    `database deadlock detected transaction=${request} shard=${shard}`
  ];
  let text = severity === 'error' ? err[i % err.length] : severity === 'warn' ? warn[i % warn.length] : common[i % common.length];
  if (i % 997 === 0) text += ' raretoken zebra incident-marker';
  if (i % 11 === 0) text += ' timeout budget observed';
  if (i % 5 === 0) text += ' cache';
  return text;
}

function rowFor(i) {
  // id 1 is newest. Rows span exactly 30 days at deterministic intervals.
  const id = i + 1;
  const base = Date.UTC(2026, 0, 31, 12, 0, 0, 0);
  const spanMs = 30 * 24 * 60 * 60 * 1000;
  const tsDate = new Date(base - Math.floor((i * spanMs) / ROW_COUNT));
  const severity = severityFor(i);
  const service = SERVICES[(i * 7) % SERVICES.length];
  const message = messageFor(i, severity, service);
  return { id, ts: tsDate.toISOString(), severity, service, message };
}

async function ensureSchemaAndSeed() {
  console.time('database ready');
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL,
      message_lc TEXT NOT NULL
    );
  `);

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const existing = Number(countResult.rows?.[0]?.count || 0);
  if (existing !== ROW_COUNT) {
    console.log(`Seeding deterministic log corpus (${existing} existing rows, target ${ROW_COUNT})...`);
    await db.query('TRUNCATE logs');
    const batchSize = 2000;
    for (let start = 0; start < ROW_COUNT; start += batchSize) {
      const values = [];
      const end = Math.min(start + batchSize, ROW_COUNT);
      for (let i = start; i < end; i++) {
        const r = rowFor(i);
        values.push(`(${r.id}, ${sqlString(r.ts)}, ${sqlString(r.severity)}, ${sqlString(r.service)}, ${sqlString(r.message)}, ${sqlString(r.message.toLowerCase())})`);
      }
      await db.query(`INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${values.join(',')}`);
      if ((start / batchSize) % 10 === 0) console.log(`  seeded ${end}/${ROW_COUNT}`);
    }
    console.log('Seed complete.');
  } else {
    console.log('Existing 100,000-row corpus detected; skipping seed.');
  }

  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC, id DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_desc ON logs (severity, ts DESC, id DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_logs_message_lc ON logs (message_lc)');
  console.timeEnd('database ready');
}

async function loadCache() {
  console.time('load in-memory query window cache');
  const result = await db.query('SELECT id, ts, severity, service, message FROM logs ORDER BY ts DESC, id DESC');
  logs = result.rows.map((r) => ({
    id: Number(r.id),
    ts: typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString(),
    severity: r.severity,
    service: r.service,
    message: r.message
  }));
  lowerMessages = logs.map((r) => r.message.toLowerCase());
  bySeverity = new Map();
  stats = { total: logs.length, severities: { debug: 0, info: 0, warn: 0, error: 0 } };
  for (const r of logs) {
    if (!bySeverity.has(r.severity)) bySeverity.set(r.severity, []);
    bySeverity.get(r.severity).push(r);
    stats.severities[r.severity]++;
  }
  console.timeEnd('load in-memory query window cache');
}

function parseLogsParams(req) {
  const offsetRaw = req.query.offset ?? '0';
  const limitRaw = req.query.limit ?? '100';
  if (!/^\d+$/.test(String(offsetRaw)) || !/^\d+$/.test(String(limitRaw))) {
    return { error: 'offset and limit must be non-negative integers' };
  }
  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(offset) || offset < 0) return { error: 'offset must be a non-negative integer' };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: `limit must be between 1 and ${MAX_LIMIT}` };
  const severity = req.query.severity ? String(req.query.severity) : '';
  if (severity && !VALID_SEVERITIES.has(severity)) return { error: 'unknown severity' };
  const q = req.query.q ? String(req.query.q).trim().toLowerCase() : '';
  return { offset, limit, severity, q };
}

function queryWindow({ offset, limit, severity, q }) {
  const base = severity ? (bySeverity.get(severity) || []) : logs;
  if (!q) {
    return { total: base.length, rows: base.slice(offset, offset + limit) };
  }

  const rows = [];
  let total = 0;
  if (!severity) {
    for (let i = 0; i < logs.length; i++) {
      if (lowerMessages[i].includes(q)) {
        if (total >= offset && rows.length < limit) rows.push(logs[i]);
        total++;
      }
    }
    return { total, rows };
  }

  for (const row of base) {
    if (row.message.toLowerCase().includes(q)) {
      if (total >= offset && rows.length < limit) rows.push(row);
      total++;
    }
  }
  return { total, rows };
}

async function main() {
  await ensureSchemaAndSeed();
  await loadCache();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true, total: stats.total }));

  app.get('/api/stats', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(stats);
  });

  app.get('/api/logs', (req, res) => {
    const parsed = parseLogsParams(req);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const result = queryWindow(parsed);
    res.set('Cache-Control', 'no-store');
    res.json(result);
  });

  app.use(express.static(path.join(ROOT, 'dist')));

  app.listen(PORT, () => {
    console.log(`Log explorer API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
