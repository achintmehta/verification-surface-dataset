import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'pgdata');

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  // PGlite is ready once the constructor resolves, but some versions
  // expose a waitReady promise. Handle both.
  if (db.waitReady) {
    await db.waitReady;
  }
  return db;
}

export async function initSchema(pgDb) {
  await pgDb.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);
}

export async function createIndexes(pgDb) {
  // Index for ordering by ts desc (general listing)
  await pgDb.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);`);
  
  // Composite index for severity filter + ts ordering
  await pgDb.exec(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);`);
  
  // For substring search, the ts DESC index helps with ordering after filtering.
  // ILIKE '%term%' won't use B-tree indexes, but the ts ordering index is still
  // useful for the ORDER BY clause, and at 100k rows a sequential scan filter
  // should be within budget.
}

export async function isSeeded(pgDb) {
  try {
    const countResult = await pgDb.query(`SELECT COUNT(*) as cnt FROM logs`);
    return parseInt(countResult.rows[0].cnt) >= 100000;
  } catch (e) {
    // Table might not exist yet
    return false;
  }
}
