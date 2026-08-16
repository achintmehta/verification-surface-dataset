import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { seedCorpus } from './seed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Persist PGLite to the local file system so data survives restarts.
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

let dbInstance = null;

/**
 * Returns a singleton, fully-initialized PGLite database.
 * On first boot the schema is created, indexes built, and the corpus seeded.
 * On subsequent boots the populated table is detected and seeding is skipped.
 */
export async function getDb() {
  if (dbInstance) return dbInstance;

  mkdirSync(DATA_DIR, { recursive: true });

  const bootStart = Date.now();
  const db = new PGlite(DATA_DIR);
  await db.waitReady;

  await createSchema(db);

  const alreadySeeded = await isSeeded(db);
  if (!alreadySeeded) {
    console.log('[db] Empty corpus detected. Seeding 100,000 rows...');
    const seedStart = Date.now();
    await seedCorpus(db);
    console.log(`[db] Seed complete in ${((Date.now() - seedStart) / 1000).toFixed(1)}s`);
  } else {
    console.log('[db] Existing corpus detected. Skipping seed.');
  }

  // Indexes are created after seeding for a faster first boot (bulk load then index).
  await createIndexes(db);

  console.log(`[db] Ready in ${((Date.now() - bootStart) / 1000).toFixed(1)}s`);

  dbInstance = db;
  return dbInstance;
}

async function createSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       BIGINT PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );
  `);
}

async function createIndexes(db) {
  // Ordering by ts descending is the base query shape.
  // (ts DESC, id DESC) gives a stable total ordering for keyset pagination and OFFSET.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts_id ON logs (ts DESC, id DESC);
  `);
  // Severity equality + ordering by ts.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_id ON logs (severity, ts DESC, id DESC);
  `);
  // Substring/case-insensitive message search. pg_trgm gives selective substring search.
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
        ON logs USING gin (lower(message) gin_trgm_ops);
    `);
  } catch (err) {
    // pg_trgm may not be available in all PGLite builds; fall back gracefully.
    console.warn('[db] pg_trgm unavailable, falling back to sequential substring scan:', err.message);
  }
  await db.exec(`ANALYZE logs;`);
}

async function isSeeded(db) {
  const res = await db.query(`SELECT EXISTS (SELECT 1 FROM logs LIMIT 1) AS present;`);
  return Boolean(res.rows[0]?.present);
}

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];
