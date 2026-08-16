import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedDatabase } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'data', 'logdb');

let db;

export async function initDatabase() {
  const startTime = Date.now();
  console.log(`Initializing PGLite at ${DB_PATH}...`);

  db = new PGlite(DB_PATH);

  // Create table if not exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity VARCHAR(5) NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service VARCHAR(64) NOT NULL,
      message TEXT NOT NULL
    )
  `);

  // Seed if needed
  const didSeed = await seedDatabase(db);

  // Create indexes (IF NOT EXISTS so safe on re-runs)
  console.log('Ensuring indexes...');

  // Index for ordering by timestamp descending (primary query shape)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_ts_desc ON logs (ts DESC)`);

  // Index for severity filtering + timestamp ordering
  await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)`);

  // Trigram index for substring search - PGLite supports pg_trgm
  // If pg_trgm is not available, we'll use a B-tree on lower(message) for LIKE prefix
  // and rely on sequential scan with index-assisted ordering for general substring.
  // Actually, PGLite may not support pg_trgm extension, so we'll use a different strategy:
  // We create an index on (ts DESC) and rely on the planner to use index scan for ORDER BY
  // with a filter condition. For severity + substring, the severity index narrows first.

  const elapsed = Date.now() - startTime;
  console.log(`Database initialization complete in ${elapsed}ms`);

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}
