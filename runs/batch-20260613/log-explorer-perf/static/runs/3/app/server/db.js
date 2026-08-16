import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { seed } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data/pglite');

let _db = null;

export async function initDb() {
  if (_db) return _db;

  // Ensure data directory exists
  mkdirSync(DATA_DIR, { recursive: true });

  console.log(`[db] Opening PGLite at ${DATA_DIR}`);
  const db = new PGlite(DATA_DIR);

  // PGlite constructor is synchronous but initialization is async
  await db.waitReady;

  // Enable pg_trgm for fast ILIKE / substring search
  await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

  // Create schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        BIGSERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT        NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service   TEXT        NOT NULL,
      message   TEXT        NOT NULL
    );

    -- Covering index for unfiltered ORDER BY ts DESC queries
    CREATE INDEX IF NOT EXISTS idx_logs_ts
      ON logs (ts DESC, id DESC);

    -- Index for severity-filtered queries ordered by ts
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts
      ON logs (severity, ts DESC, id DESC);

    -- GIN trigram index on message for fast ILIKE substring search
    CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
      ON logs USING GIN (message gin_trgm_ops);
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*) AS cnt FROM logs');
  const existingCount = parseInt(countResult.rows[0].cnt, 10);

  if (existingCount < 100000) {
    console.log(`[db] Seeding database (found ${existingCount} rows)…`);
    const t0 = Date.now();
    await seed(db);
    console.log(`[db] Seeding complete in ${Date.now() - t0}ms`);
  } else {
    console.log(`[db] Database already seeded (${existingCount} rows), skipping.`);
  }

  _db = db;
  return db;
}
