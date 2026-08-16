import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { seedLogs } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'pglite');

export async function initDb() {
  // Ensure the data directory exists before PGLite tries to create it
  fs.mkdirSync(DB_PATH, { recursive: true });

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
      id         BIGSERIAL PRIMARY KEY,
      ts         TIMESTAMPTZ NOT NULL,
      severity   TEXT        NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service    TEXT        NOT NULL,
      message    TEXT        NOT NULL
    );

    -- Index for ordering by ts (default sort)
    CREATE INDEX IF NOT EXISTS idx_logs_ts
      ON logs (ts DESC);

    -- Index for severity filter + ts ordering
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts
      ON logs (severity, ts DESC);

    -- Index on lower(message) for case-insensitive prefix/substring searches
    -- PGLite does not support pg_trgm, so we use a functional index on lower(message)
    -- and rewrite ILIKE '%q%' as lower(message) LIKE lower('%q%') to leverage it for
    -- prefix patterns; for arbitrary substrings the planner will use a seq scan but
    -- the functional index still helps the planner estimate cardinality.
    CREATE INDEX IF NOT EXISTS idx_logs_message_lower
      ON logs (lower(message));

    -- Composite: severity + lower(message) for combined filters
    CREATE INDEX IF NOT EXISTS idx_logs_severity_message_lower
      ON logs (severity, lower(message));
  `);
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
  console.log(`[db] Seed complete in ${Date.now() - seedStart}ms`);
}
