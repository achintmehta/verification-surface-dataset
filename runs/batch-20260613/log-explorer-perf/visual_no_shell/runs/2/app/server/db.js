import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedLogs } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'pglite-db');

let dbInstance = null;

export async function initDb() {
  if (dbInstance) return dbInstance;

  console.log(`Opening PGLite database at: ${DB_PATH}`);
  const db = new PGlite(`file://${DB_PATH}`);

  // Wait for PGLite to be ready
  await db.waitReady;

  // Create schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        BIGINT PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service   TEXT NOT NULL,
      message   TEXT NOT NULL
    );

    -- Index for ordering by ts (most common query shape)
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);

    -- Index for severity + ts ordering
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);

    -- Index for service + ts
    CREATE INDEX IF NOT EXISTS idx_logs_service_ts ON logs (service, ts DESC);
  `);

  // Check if we need to seed
  const countResult = await db.query('SELECT COUNT(*) as cnt FROM logs');
  const count = parseInt(countResult.rows[0].cnt, 10);

  if (count < 100000) {
    console.log(`Found ${count} rows, seeding 100,000 log entries...`);
    const start = Date.now();
    await seedLogs(db);
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`Seeding complete in ${elapsed}s`);
  } else {
    console.log(`Database already has ${count} rows, skipping seed.`);
  }

  dbInstance = db;
  return db;
}
