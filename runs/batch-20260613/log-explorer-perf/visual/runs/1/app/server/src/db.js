import { PGlite } from '@electric-sql/pglite';
import { generateRows } from './seed.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/pglite');

let db;

export async function getDb() {
  if (db) return db;
  throw new Error('Database not initialized. Call initDb() first.');
}

export async function initDb() {
  console.log(`[db] Opening PGLite at ${DB_PATH}`);
  db = new PGlite(DB_PATH);

  // Create schema
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
  // Index for ordering by ts (most common sort)
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
  `);

  // Index for severity + ts ordering
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*) AS cnt FROM logs');
  const existingCount = parseInt(countResult.rows[0].cnt, 10);

  if (existingCount >= 100_000) {
    console.log(`[db] Already seeded with ${existingCount} rows. Skipping seed.`);
    return db;
  }

  console.log(`[db] Seeding 100,000 rows (existing: ${existingCount})...`);
  const seedStart = Date.now();

  // Clear any partial data
  if (existingCount > 0) {
    await db.exec('TRUNCATE logs RESTART IDENTITY');
  }

  const rows = generateRows(100_000);

  // Batch insert in chunks of 1000
  const BATCH_SIZE = 1000;
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
      console.log(`[db] Seeded ${i + batch.length} / 100000 rows...`);
    }
  }

  const seedMs = Date.now() - seedStart;
  console.log(`[db] Seeding complete in ${seedMs}ms`);

  return db;
}
