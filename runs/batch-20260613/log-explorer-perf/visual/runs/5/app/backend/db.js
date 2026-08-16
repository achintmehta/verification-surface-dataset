import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { generateRows } from './seed.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'data', 'pglite');

let db;

export async function initDb() {
  console.log(`[db] Opening PGLite at ${DB_PATH}`);
  db = new PGlite(`file://${DB_PATH}`, {
    extensions: { pg_trgm },
  });

  // Create schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        BIGSERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT        NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service   TEXT        NOT NULL,
      message   TEXT        NOT NULL
    );

    -- Index for ordering by ts (covers unfiltered queries)
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);

    -- Index for severity + ts ordering (covers severity-filtered queries)
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
  `);

  // Try to create pg_trgm extension and index
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING GIN (message gin_trgm_ops);`);
    console.log('[db] pg_trgm extension loaded successfully');
  } catch (err) {
    console.warn('[db] pg_trgm not available, falling back to ILIKE without trigram index:', err.message);
  }

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*) AS cnt FROM logs');
  const existingCount = parseInt(countResult.rows[0].cnt, 10);

  if (existingCount >= 100000) {
    console.log(`[db] Already seeded with ${existingCount} rows, skipping seed.`);
    return db;
  }

  console.log(`[db] Seeding 100,000 rows (existing: ${existingCount})...`);
  const t0 = Date.now();

  // Clear any partial seed
  if (existingCount > 0) {
    await db.exec('TRUNCATE logs RESTART IDENTITY');
  }

  const rows = generateRows(100000);

  // Batch insert in chunks of 500 rows using multi-row VALUES
  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = batch
      .map((_, j) => {
        const base = j * 4;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
      })
      .join(', ');
    const params = batch.flatMap((r) => [r.ts, r.severity, r.service, r.message]);
    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${values}`,
      params
    );

    if ((i / BATCH_SIZE) % 20 === 0) {
      console.log(`[db] Inserted ${Math.min(i + BATCH_SIZE, rows.length)} / ${rows.length} rows...`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[db] Seeding complete in ${elapsed}s`);

  // Update planner statistics so indexes are used optimally
  console.log('[db] Running ANALYZE...');
  await db.exec('ANALYZE logs');
  console.log('[db] ANALYZE complete');

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}
