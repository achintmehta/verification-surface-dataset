import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedLogs } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'pglite');

export async function initDb() {
  console.log(`[db] Opening PGLite at ${DB_PATH}`);
  // PGlite accepts a filesystem path directly in Node.js
  const db = new PGlite(DB_PATH);

  await db.waitReady;
  console.log('[db] PGLite ready');

  await createSchema(db);
  await maybeReseed(db);

  return db;
}

async function createSchema(db) {
  // Create table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id         BIGSERIAL PRIMARY KEY,
      ts         TIMESTAMPTZ NOT NULL,
      severity   TEXT        NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service    TEXT        NOT NULL,
      message    TEXT        NOT NULL
    )
  `);

  // Index for ordering by ts (default sort, covers unfiltered queries)
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts
      ON logs (ts DESC)
  `);

  // Index for severity equality + ts ordering (covers severity-filtered queries)
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts
      ON logs (severity, ts DESC)
  `);

  // Enable pg_trgm for fast ILIKE substring search
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    // GIN trigram index for case-insensitive substring search on message
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
        ON logs USING GIN (message gin_trgm_ops)
    `);
    console.log('[db] pg_trgm extension and trigram index created');
  } catch (err) {
    console.warn('[db] pg_trgm not available, substring search will use sequential scan:', err.message);
    // Fallback: create a regular index on message for prefix searches
    // ILIKE will still work, just slower for non-selective terms
  }

  console.log('[db] Schema and indexes ensured');
}

async function maybeReseed(db) {
  const result = await db.query('SELECT COUNT(*) AS cnt FROM logs');
  const count = parseInt(result.rows[0].cnt, 10);

  if (count >= 100000) {
    console.log(`[db] Corpus already seeded (${count} rows), skipping seed`);
    return;
  }

  if (count > 0) {
    console.log(`[db] Partial seed detected (${count} rows), truncating and reseeding`);
    await db.exec('TRUNCATE logs RESTART IDENTITY');
  }

  console.log('[db] Seeding 100,000 log entries...');
  const seedStart = Date.now();
  await seedLogs(db);
  console.log(`[db] Seeding complete in ${Date.now() - seedStart}ms`);
}
