import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3001);
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'pglite-data');
const ROW_COUNT = 100_000;
const BATCH_SIZE = 1000;
const SERVICES = ['auth', 'api', 'billing', 'search', 'worker', 'notifier', 'storage', 'scheduler'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const VALID_SEVERITIES = new Set(SEVERITIES);
const MAX_LIMIT = 200;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new PGlite(DATA_DIR);

function severityFor(i) {
  // Deterministic 60/25/10/5 distribution per block of 100 rows.
  const r = i % 100;
  if (r < 60) return 'debug';
  if (r < 85) return 'info';
  if (r < 95) return 'warn';
  return 'error';
}

function messageFor(i, severity, service) {
  const user = `user-${(i * 17) % 10000}`;
  const request = `req-${String((i * 7919) % 1000000).padStart(6, '0')}`;
  const ms = 5 + ((i * 37) % 2500);
  const shard = (i * 13) % 64;
  const path = ['/login', '/checkout', '/query', '/upload', '/notify', '/health', '/sync', '/report'][i % 8];
  const region = ['us-east', 'us-west', 'eu-central', 'ap-south'][i % 4];
  const rare = (i % 997 === 0) ? ' rare-unicorn' : '';
  const timeout = (i % 113 === 0) ? ' timeout' : '';
  const cache = (i % 3 === 0) ? ' cache hit' : ' cache miss';

  const templates = [
    `${service} handled ${path} for ${user} request=${request} latency=${ms}ms region=${region}${cache}${rare}`,
    `${service} background job completed shard=${shard} request=${request} items=${(i * 23) % 5000} latency=${ms}ms${rare}`,
    `${service} database query ${timeout || 'ok'} table=events shard=${shard} request=${request} latency=${ms}ms`,
    `${service} ${severity} checkpoint request=${request} user=${user} region=${region} message=service heartbeat${rare}`,
    `${service} retry policy evaluated attempt=${(i % 5) + 1} request=${request} status=${severity === 'error' ? 'failed' : 'accepted'}${timeout}`,
    `${service} queue processed topic=logs partition=${shard % 12} request=${request} lag=${(i * 31) % 10000}ms`,
  ];
  return templates[i % templates.length];
}

function rowFor(i) {
  // id is 1-based. ts spans exactly 30 days and is unique/monotonic, making ts DESC == id DESC.
  const id = i + 1;
  const start = Date.UTC(2024, 0, 1, 0, 0, 0);
  const span = 30 * 24 * 60 * 60 * 1000;
  const ts = new Date(start + Math.floor((i * span) / ROW_COUNT)).toISOString();
  const severity = severityFor(i);
  const service = SERVICES[i % SERVICES.length];
  const message = messageFor(i, severity, service);
  return { id, ts, severity, service, message, message_lc: message.toLowerCase() };
}

async function setupSchema() {
  await db.exec(`
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

async function seedIfNeeded() {
  const existing = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const count = Number(existing.rows[0]?.count || 0);
  if (count === ROW_COUNT) {
    console.log(`PGLite corpus already seeded (${count} rows).`);
    return;
  }
  if (count > 0) {
    console.warn(`Found partial corpus (${count} rows); reseeding deterministic corpus.`);
    await db.exec('TRUNCATE logs;');
  }

  console.time('seed');
  await db.exec('BEGIN;');
  try {
    for (let start = 0; start < ROW_COUNT; start += BATCH_SIZE) {
      const values = [];
      const placeholders = [];
      const end = Math.min(start + BATCH_SIZE, ROW_COUNT);
      for (let i = start; i < end; i++) {
        const r = rowFor(i);
        const base = values.length;
        placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
        values.push(r.id, r.ts, r.severity, r.service, r.message, r.message_lc);
      }
      await db.query(
        `INSERT INTO logs (id, ts, severity, service, message, message_lc) VALUES ${placeholders.join(',')}`,
        values,
      );
      if ((start / BATCH_SIZE) % 10 === 0) console.log(`seeded ${end}/${ROW_COUNT}`);
    }
    await db.exec('COMMIT;');
  } catch (err) {
    await db.exec('ROLLBACK;');
    throw err;
  }
  console.timeEnd('seed');
}

async function createIndexes() {
  console.time('indexes');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS logs_ts_desc_idx ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS logs_severity_ts_desc_idx ON logs (severity, ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS logs_message_lc_idx ON logs (message_lc);
    ANALYZE logs;
  `);
  console.timeEnd('indexes');
}

function parseLogsQuery(req, res) {
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
  const severity = req.query.severity ? String(req.query.severity) : '';
  const q = req.query.q ? String(req.query.q).trim() : '';

  if (!Number.isInteger(offset) || offset < 0) {
    res.status(400).json({ error: 'offset must be a non-negative integer' });
    return null;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    res.status(400).json({ error: `limit must be an integer from 1 to ${MAX_LIMIT}` });
    return null;
  }
  if (severity && !VALID_SEVERITIES.has(severity)) {
    res.status(400).json({ error: 'unknown severity' });
    return null;
  }
  if (q.length > 200) {
    res.status(400).json({ error: 'q must be at most 200 characters' });
    return null;
  }
  return { offset, limit, severity, q };
}

function buildWhere({ severity, q }) {
  const where = [];
  const params = [];
  if (severity) {
    params.push(severity);
    where.push(`severity = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase().replace(/[\\%_]/g, m => '\\' + m)}%`);
    where.push(`message_lc LIKE $${params.length} ESCAPE '\\'`);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function rowMapper(r) {
  return {
    id: Number(r.id),
    ts: r.ts instanceof Date ? r.ts.toISOString() : r.ts,
    severity: r.severity,
    service: r.service,
    message: r.message,
  };
}

async function start() {
  await setupSchema();
  await seedIfNeeded();
  await createIndexes();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/stats', async (_req, res, next) => {
    try {
      const result = await db.query(`
        SELECT severity, COUNT(*)::int AS count
        FROM logs
        GROUP BY severity
      `);
      const perSeverity = Object.fromEntries(SEVERITIES.map(s => [s, 0]));
      let total = 0;
      for (const row of result.rows) {
        perSeverity[row.severity] = Number(row.count);
        total += Number(row.count);
      }
      res.json({ total, perSeverity });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/logs', async (req, res, next) => {
    const parsed = parseLogsQuery(req, res);
    if (!parsed) return;
    try {
      const { clause, params } = buildWhere(parsed);
      const countResult = await db.query(`SELECT COUNT(*)::int AS total FROM logs ${clause}`, params);
      const total = Number(countResult.rows[0]?.total || 0);

      const queryParams = [...params, parsed.limit, parsed.offset];
      const rowsResult = await db.query(
        `SELECT id, ts, severity, service, message
         FROM logs
         ${clause}
         ORDER BY ts DESC, id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        queryParams,
      );
      res.json({ total, rows: rowsResult.rows.map(rowMapper) });
    } catch (err) {
      next(err);
    }
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  app.listen(PORT, () => {
    console.log(`Log explorer API listening on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
