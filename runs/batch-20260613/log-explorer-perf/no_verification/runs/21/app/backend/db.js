import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'pgdata');

let db = null;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  // PGlite v0.2+ — waitReady is a promise that resolves when the DB is ready.
  // In some versions it may not exist (already ready after construction completes).
  if (db.waitReady) {
    await db.waitReady;
  }
  return db;
}

export async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity VARCHAR(5) NOT NULL,
      service VARCHAR(64) NOT NULL,
      message TEXT NOT NULL
    );
  `);
}

export async function createIndexes(db) {
  // Index for ordering by ts descending (covers unfiltered queries)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);`);
  // Composite index for severity filtering + ts ordering
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);`);
}

export async function isSeeded(db) {
  try {
    const result = await db.query('SELECT 1 FROM logs LIMIT 1;');
    return result.rows.length > 0;
  } catch {
    return false;
  }
}
