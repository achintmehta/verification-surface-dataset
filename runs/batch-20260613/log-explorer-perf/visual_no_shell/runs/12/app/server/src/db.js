import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seedCorpus } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist PGLite to the local file system so restarts don't reseed.
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

let dbInstance = null;

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];
export const SEED_TARGET = 100000;

export async function getDb() {
  if (dbInstance) return dbInstance;

  fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });

  const db = new PGlite(DATA_DIR);
  await db.waitReady;

  await initSchema(db);
  await ensureSeed(db);

  dbInstance = db;
  return db;
}

async function initSchema(db) {
  // Create the table if it doesn't exist. We use text for severity but
  // constrain it in the CHECK so bad data can't sneak in.
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
  // Ordering index for the default (unfiltered) descending-by-ts window.
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);`);
  // Severity equality + ordering: covers severity-filtered windows.
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_sev_ts ON logs (severity, ts DESC, id DESC);`);
  // Trigram index accelerates case-insensitive substring (ILIKE '%...%') search.
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_logs_msg_trgm ON logs USING gin (lower(message) gin_trgm_ops);`
    );
  } catch (err) {
    // If the trigram extension is unavailable, substring search still works
    // (just via scan on the ts-ordered index); log and continue.
    console.warn('[db] pg_trgm unavailable, substring search will not use a trigram index:', err.message);
  }
}

async function ensureSeed(db) {
  const res = await db.query('SELECT COUNT(*)::int AS c FROM logs;');
  const count = res.rows[0].c;

  if (count >= SEED_TARGET) {
    // Already populated: make sure indexes exist (cheap if present) and skip.
    await createIndexes(db);
    console.log(`[db] Existing corpus detected (${count} rows). Skipping seed.`);
    return;
  }

  if (count > 0) {
    // Partial / stale seed: clear and reseed to guarantee determinism.
    console.log(`[db] Partial corpus (${count} rows) found. Clearing and reseeding.`);
    await db.exec('DELETE FROM logs;');
  }

  const start = Date.now();
  await seedCorpus(db, SEED_TARGET);
  console.log(`[db] Seeded ${SEED_TARGET} rows in ${((Date.now() - start) / 1000).toFixed(1)}s.`);

  // Build indexes AFTER bulk load for a much faster seed.
  const idxStart = Date.now();
  await createIndexes(db);
  await db.exec('ANALYZE logs;');
  console.log(`[db] Built indexes in ${((Date.now() - idxStart) / 1000).toFixed(1)}s.`);
}
