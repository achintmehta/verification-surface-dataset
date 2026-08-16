import { PGlite } from '@electric-sql/pglite';
import { seed } from './seed.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'pglite-db');

let dbInstance = null;

export async function initDb() {
  if (dbInstance) return dbInstance;

  console.log(`Opening PGLite database at: ${DB_PATH}`);
  const db = new PGlite(`file://${DB_PATH}`);

  // Create schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        BIGSERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT        NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service   TEXT        NOT NULL,
      message   TEXT        NOT NULL
    );

    -- Index for ordering by ts (most common sort)
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);

    -- Index for severity + ts ordering
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);

    -- Index for ts ascending (needed for keyset pagination)
    CREATE INDEX IF NOT EXISTS idx_logs_ts_asc ON logs (ts ASC);
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*) as cnt FROM logs');
  const count = parseInt(countResult.rows[0].cnt, 10);

  if (count === 0) {
    console.log('Seeding 100,000 log entries...');
    const start = Date.now();
    await seed(db);
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`Seeding complete in ${elapsed}s`);
  } else {
    console.log(`Database already contains ${count} rows, skipping seed.`);
  }

  dbInstance = db;
  return db;
}
