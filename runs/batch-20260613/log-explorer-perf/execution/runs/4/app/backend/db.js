import { PGlite } from '@electric-sql/pglite';
import { generateRows } from './seed.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'data', 'logs.db');

let db;

export async function initDb() {
  console.log(`[db] Opening PGLite at ${DB_PATH}`);
  db = new PGlite(`file://${DB_PATH}`);

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

  // Create indexes
  // 1. Ordering by ts (covers unfiltered windowed queries)
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
  `);

  // 2. Severity + ts (covers severity-filtered windowed queries)
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
  `);

  // 3. For substring search we use pg_trgm GIN index for fast ILIKE
  // PGLite supports pg_trgm extension
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

  // Batch insert in chunks of 1000
  const BATCH_SIZE = 1000;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    // Build a multi-row VALUES insert
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const row of batch) {
      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(row.ts, row.severity, row.service, row.message);
    }

    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')}`,
      params
    );

    if ((i / BATCH_SIZE) % 20 === 0) {
      console.log(`[db] Seeded ${i + batch.length} / 100000 rows...`);
    }
  }

  // Run ANALYZE after bulk insert for better query plans
  await db.exec('ANALYZE logs;');

  const seedMs = Date.now() - seedStart;
  console.log(`[db] Seeding complete in ${seedMs}ms`);

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}
