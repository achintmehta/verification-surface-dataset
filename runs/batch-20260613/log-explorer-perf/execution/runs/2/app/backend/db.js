/**
 * PGLite database initialization, schema creation, indexing, and seeding.
 */
import { PGlite } from '@electric-sql/pglite';
import { generateRows } from './seed.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'data', 'logs.db');

let db;

export async function initDb() {
  console.log(`[db] Opening PGLite at ${DB_PATH}`);
  db = new PGlite(DB_PATH);

  await db.waitReady;
  console.log('[db] PGLite ready');

  // Create table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        BIGSERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT        NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service   TEXT        NOT NULL,
      message   TEXT        NOT NULL
    );
  `);

  // Create indexes for the two primary query shapes:
  // 1. ORDER BY ts DESC (all queries)
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
  `);

  // 2. severity equality + ORDER BY ts DESC
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
  `);

  // 3. For substring search: pg_trgm GIN index for fast ILIKE
  //    PGLite supports pg_trgm extension
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING GIN (message gin_trgm_ops);
    `);
    console.log('[db] pg_trgm extension and GIN index created');
  } catch (e) {
    console.warn('[db] pg_trgm not available, falling back to sequential scan for ILIKE:', e.message);
  }

  // Check if seeding is needed
  const countResult = await db.query('SELECT COUNT(*) as cnt FROM logs');
  const existingCount = parseInt(countResult.rows[0].cnt, 10);

  if (existingCount >= 100000) {
    console.log(`[db] Corpus already seeded (${existingCount} rows), skipping seed`);
    return db;
  }

  console.log(`[db] Seeding 100,000 rows (existing: ${existingCount})...`);
  const seedStart = Date.now();

  // Clear any partial seed
  if (existingCount > 0) {
    await db.exec('TRUNCATE logs RESTART IDENTITY');
  }

  const rows = generateRows(100000);

  // Batch insert in chunks of 1000 rows using multi-row VALUES
  const BATCH_SIZE = 1000;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    // Build parameterized query
    const params = [];
    const valueClauses = batch.map((row, j) => {
      const base = j * 4;
      params.push(row.ts, row.severity, row.service, row.message);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    });

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${valueClauses.join(',')}`;
    await db.query(sql, params);

    if ((i / BATCH_SIZE) % 20 === 0) {
      console.log(`[db] Seeded ${i + batch.length} / ${rows.length} rows...`);
    }
  }

  const seedMs = Date.now() - seedStart;
  console.log(`[db] Seeding complete in ${seedMs}ms`);

  // Run ANALYZE to update planner statistics after bulk insert
  await db.exec('ANALYZE logs;');
  console.log('[db] ANALYZE complete');

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}
