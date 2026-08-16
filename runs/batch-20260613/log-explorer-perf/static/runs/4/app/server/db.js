import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedLogs } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'pglite');

export async function initDb() {
  console.log(`[db] Opening PGLite at ${DB_PATH}`);
  const db = new PGlite(DB_PATH);

  await db.waitReady;

  // Create schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id         BIGSERIAL PRIMARY KEY,
      ts         TIMESTAMPTZ NOT NULL,
      severity   TEXT        NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service    TEXT        NOT NULL,
      message    TEXT        NOT NULL
    );
  `);

  // Create indexes for the two primary query shapes:
  // 1. ORDER BY ts DESC (all queries)
  // 2. severity equality + ORDER BY ts DESC
  // 3. Substring search via pg_trgm GIN index
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts
      ON logs (ts DESC);

    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts
      ON logs (severity, ts DESC);
  `);

  // Try to create trigram index for fast ILIKE; gracefully skip if extension unavailable
  try {
    await db.exec(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
        ON logs USING GIN (message gin_trgm_ops);
    `);
    console.log('[db] pg_trgm extension and GIN index created');
  } catch (err) {
    console.warn('[db] pg_trgm not available, falling back to sequential scan for ILIKE:', err.message);
  }

  // Check if seeding is needed
  const countResult = await db.query('SELECT COUNT(*) AS cnt FROM logs');
  const existingCount = parseInt(countResult.rows[0].cnt, 10);

  if (existingCount >= 100000) {
    console.log(`[db] Corpus already seeded (${existingCount} rows), skipping seed`);
  } else {
    console.log(`[db] Seeding corpus (found ${existingCount} rows)...`);
    const seedStart = Date.now();
    await seedLogs(db);
    console.log(`[db] Seeding complete in ${Date.now() - seedStart}ms`);
  }

  return db;
}
