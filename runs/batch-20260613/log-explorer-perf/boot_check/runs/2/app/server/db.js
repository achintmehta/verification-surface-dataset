import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import { seed } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../data/pglite');

let _db = null;

export async function initDb() {
  if (_db) return _db;

  console.log(`[db] Opening PGLite at ${DB_PATH}`);
  const db = new PGlite(`file://${DB_PATH}`);

  // Create schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        BIGINT PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT NOT NULL,
      service   TEXT NOT NULL,
      message   TEXT NOT NULL
    );

    -- Index for ordering by ts (default sort)
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);

    -- Index for severity filter + ts ordering
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);

    -- Index for ts ascending (used internally)
    CREATE INDEX IF NOT EXISTS idx_logs_ts_asc ON logs (ts ASC);
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*) AS cnt FROM logs');
  const existingCount = parseInt(countResult.rows[0].cnt, 10);

  if (existingCount < 100000) {
    console.log(`[db] Found ${existingCount} rows, seeding to 100,000...`);
    const t0 = Date.now();
    await seed(db, existingCount);
    console.log(`[db] Seeding complete in ${Date.now() - t0}ms`);
  } else {
    console.log(`[db] Found ${existingCount} rows, skipping seed.`);
  }

  _db = db;
  return db;
}
