// PGLite initialization, schema, indexes, and batched seeding.
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateCorpus, TOTAL_ROWS, SEVERITIES } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Persist the database to the local filesystem so restarts skip reseeding.
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

let db = null;

async function ensureSchema() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       BIGSERIAL PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );
  `);
}

async function ensureIndexes() {
  // Ordering index on ts (descending is the default query order). A composite
  // (ts, id) keeps ordering total/stable for keyset pagination.
  // Severity + ts composite supports severity-equality + ordering.
  // A trigram-like substring search would require the pg_trgm extension which
  // is not bundled; we instead rely on a lower(message) expression index that
  // can back a prefix/ILIKE search plan and keep the message column narrow.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS logs_ts_id_desc      ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS logs_sev_ts_id_desc  ON logs (severity, ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS logs_msg_lower        ON logs (lower(message));
  `);
}

async function isSeeded() {
  // Detect a populated table without a full count: probe for a single row.
  const res = await db.query('SELECT 1 FROM logs LIMIT 1;');
  if (res.rows.length === 0) return false;
  // Ensure the count matches the expected corpus size; if a prior seed was
  // interrupted, reseed.
  const countRes = await db.query('SELECT COUNT(*)::int AS c FROM logs;');
  return countRes.rows[0].c === TOTAL_ROWS;
}

async function seed() {
  const t0 = Date.now();
  console.log('[db] seeding corpus...');

  const rows = generateCorpus();

  // Batched multi-row INSERTs. PGLite is in-process; large parameterized
  // statements are fast. We wrap the whole seed in a single transaction.
  const BATCH = 1000;
  await db.exec('BEGIN;');
  try {
    // Truncate in case of a partial prior seed.
    await db.exec('TRUNCATE logs RESTART IDENTITY;');
    for (let start = 0; start < rows.length; start += BATCH) {
      const chunk = rows.slice(start, start + BATCH);
      const values = [];
      const params = [];
      chunk.forEach((r, i) => {
        const b = i * 4;
        values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`);
        params.push(r.ts, r.severity, r.service, r.message);
      });
      await db.query(
        `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')};`,
        params
      );
    }
    await db.exec('COMMIT;');
  } catch (err) {
    await db.exec('ROLLBACK;');
    throw err;
  }

  // ANALYZE so the planner uses the indexes.
  await db.exec('ANALYZE logs;');
  console.log(`[db] seeded ${rows.length} rows in ${Date.now() - t0}ms`);
}

export async function initDb() {
  if (db) return db;
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  await ensureSchema();
  await ensureIndexes();

  if (await isSeeded()) {
    console.log('[db] existing corpus detected, skipping seed');
  } else {
    await seed();
  }
  return db;
}

export function getDb() {
  if (!db) throw new Error('db not initialized');
  return db;
}

export { SEVERITIES, TOTAL_ROWS };
