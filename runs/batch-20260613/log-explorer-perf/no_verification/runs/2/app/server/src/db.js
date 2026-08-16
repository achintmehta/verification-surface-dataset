import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedLogs } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/pglite');

export async function initDb() {
  console.log(`[db] Opening PGLite at ${DB_PATH}`);
  const db = new PGlite(DB_PATH);

  await db.waitReady;
  console.log('[db] PGLite ready');

  await createSchema(db);
  await maybeReseed(db);

  return db;
}

async function createSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id         BIGINT PRIMARY KEY,
      ts         TIMESTAMPTZ NOT NULL,
      severity   TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service    TEXT NOT NULL,
      message    TEXT NOT NULL
    );

    -- Primary ordering index (ts DESC is the default sort)
    CREATE INDEX IF NOT EXISTS idx_logs_ts
      ON logs (ts DESC);

    -- Severity + ts for severity-filtered queries
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts
      ON logs (severity, ts DESC);

    -- pg_trgm-based index for fast ILIKE substring search
    -- We use a functional lower() index as a fallback since pglite may not have pg_trgm
    CREATE INDEX IF NOT EXISTS idx_logs_message_lower
      ON logs (lower(message));
  `);

  // Try to enable pg_trgm for faster ILIKE; ignore if unavailable
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
        ON logs USING gin (message gin_trgm_ops);
    `);
    console.log('[db] pg_trgm extension enabled with GIN index');
  } catch {
    console.log('[db] pg_trgm not available; using lower() index for substring search');
  }

  console.log('[db] Schema and indexes ready');
}

async function maybeReseed(db) {
  const result = await db.query('SELECT COUNT(*) AS cnt FROM logs');
  const count = parseInt(result.rows[0].cnt, 10);

  if (count >= 100000) {
    console.log(`[db] Corpus already seeded (${count} rows); skipping seed`);
    return;
  }

  if (count > 0) {
    console.log(`[db] Partial seed detected (${count} rows); truncating and reseeding`);
    await db.exec('TRUNCATE logs');
  }

  console.log('[db] Seeding 100,000 log entries...');
  const seedStart = Date.now();
  await seedLogs(db);
  const elapsed = ((Date.now() - seedStart) / 1000).toFixed(2);
  console.log(`[db] Seeding complete in ${elapsed}s`);
}
