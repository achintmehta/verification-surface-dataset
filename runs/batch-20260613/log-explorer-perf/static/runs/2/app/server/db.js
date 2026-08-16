import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import { seed } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data/pglite');

export async function initDb() {
  console.log(`[db] Opening PGLite at ${DATA_DIR}`);
  const db = new PGlite(`file://${DATA_DIR}`);

  // Wait for PGLite to be ready
  await db.waitReady;

  // Create schema (idempotent)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        BIGSERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT        NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service   TEXT        NOT NULL,
      message   TEXT        NOT NULL
    );

    -- Index for ordering by ts (most common sort)
    CREATE INDEX IF NOT EXISTS idx_logs_ts
      ON logs (ts DESC);

    -- Index for severity-filtered queries ordered by ts
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts
      ON logs (severity, ts DESC);
  `);

  // Try to enable pg_trgm for fast ILIKE — gracefully skip if unavailable in this PGLite build
  try {
    await db.exec(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
        ON logs USING GIN (message gin_trgm_ops);
    `);
    console.log('[db] pg_trgm GIN index enabled for fast substring search');
  } catch (e) {
    console.warn('[db] pg_trgm not available — substring search will use sequential scan:', e.message);
  }

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*) AS cnt FROM logs');
  const existingCount = parseInt(countResult.rows[0].cnt, 10);

  if (existingCount === 0) {
    console.log('[db] Table is empty — seeding 100,000 rows…');
    const t0 = Date.now();
    await seed(db);
    console.log(`[db] Seeding complete in ${Date.now() - t0} ms`);
  } else {
    console.log(`[db] Found ${existingCount} existing rows — skipping seed`);
  }

  return db;
}
