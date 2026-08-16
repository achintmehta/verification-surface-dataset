import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOTAL_ROWS, buildRow } from './seed-data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist to the local filesystem so restarts reuse the corpus (no reseed).
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

let db = null;

/**
 * Open (or create) the embedded PGLite database, ensure schema + indexes,
 * and seed exactly TOTAL_ROWS rows on first boot only.
 * Returns the PGlite instance.
 */
export async function initDb() {
  const t0 = Date.now();
  db = new PGlite(DATA_DIR);
  await db.waitReady;

  await createSchema();
  const seeded = await isSeeded();
  if (!seeded) {
    console.log('[db] empty corpus detected — seeding %d rows...', TOTAL_ROWS);
    await seed();
    console.log('[db] seed complete in %dms', Date.now() - t0);
  } else {
    console.log('[db] existing corpus detected — skipping seed');
  }

  // Indexes are created after seeding so the bulk insert isn't slowed by index
  // maintenance; on subsequent boots CREATE INDEX IF NOT EXISTS is a no-op.
  await createIndexes();

  console.log('[db] ready in %dms', Date.now() - t0);
  return db;
}

async function createSchema() {
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

async function isSeeded() {
  const res = await db.query('SELECT COUNT(*)::int AS n FROM logs;');
  return res.rows[0].n >= TOTAL_ROWS;
}

async function createIndexes() {
  // Ordering by ts descending is the primary query shape. A btree on (ts, id)
  // supports the global ordering and keyset pagination (id breaks ties).
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts_id ON logs (ts DESC, id DESC);
  `);
  // Severity equality + ordering by ts.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_sev_ts_id ON logs (severity, ts DESC, id DESC);
  `);
  // Case-insensitive substring search. A trigram GIN index makes ILIKE '%q%'
  // index-backed instead of a full scan. pg_trgm ships with PGLite's contrib.
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_msg_trgm
      ON logs USING gin (lower(message) gin_trgm_ops);
    `);
  } catch (err) {
    // If the trigram extension is unavailable in this build, fall back
    // gracefully — searches still work, just without index acceleration.
    console.warn('[db] pg_trgm unavailable, substring search will not be index-accelerated:', err.message);
  }
}

async function seed() {
  // Batch inserts using multi-row VALUES within a transaction. Row-by-row
  // inserts of 100k rows would blow the boot budget; batching keeps it well
  // under 60s.
  const BATCH = 2000;
  await db.exec('BEGIN;');
  try {
    for (let start = 0; start < TOTAL_ROWS; start += BATCH) {
      const end = Math.min(start + BATCH, TOTAL_ROWS);
      const values = [];
      const params = [];
      let p = 1;
      for (let i = start; i < end; i++) {
        const r = buildRow(i);
        values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(r.ts, r.severity, r.service, r.message);
      }
      const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')};`;
      await db.query(sql, params);
    }
    await db.exec('COMMIT;');
  } catch (err) {
    await db.exec('ROLLBACK;');
    throw err;
  }
}

export function getDb() {
  if (!db) throw new Error('DB not initialized');
  return db;
}
