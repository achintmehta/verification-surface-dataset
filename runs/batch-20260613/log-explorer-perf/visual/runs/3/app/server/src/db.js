import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { generateSeedRows, TOTAL_ROWS } from './seed.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../../data/pglite');

let db;

export async function initDb() {
  console.log(`[db] Opening PGLite at ${DB_PATH}`);
  db = new PGlite(DB_PATH, {
    extensions: { pg_trgm },
  });

  await db.waitReady;
  console.log('[db] PGLite ready');

  await createSchema();
  await maybeReseed();

  return db;
}

async function createSchema() {
  // Create extension first (must be done before creating indexes that use it)
  await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        BIGSERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT        NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service   TEXT        NOT NULL,
      message   TEXT        NOT NULL
    );

    -- Index for ordering by ts (covers unfiltered windowed queries)
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);

    -- Index for severity + ts ordering (covers severity-filtered queries)
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);

    -- GIN trigram index for case-insensitive substring search on message
    CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING GIN (message gin_trgm_ops);
  `);
  console.log('[db] Schema and indexes ready');
}

async function maybeReseed() {
  const result = await db.query('SELECT COUNT(*) AS cnt FROM logs');
  const count = parseInt(result.rows[0].cnt, 10);

  if (count >= TOTAL_ROWS) {
    console.log(`[db] Already seeded with ${count} rows, skipping seed`);
    return;
  }

  console.log(`[db] Seeding ${TOTAL_ROWS} rows (found ${count})...`);
  const t0 = Date.now();

  const rows = generateSeedRows();

  // Batch insert in chunks of 1000 rows using multi-row VALUES
  const BATCH_SIZE = 1000;
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
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

    if ((start / BATCH_SIZE) % 10 === 0) {
      console.log(`[db] Seeded ${Math.min(start + BATCH_SIZE, rows.length)} / ${TOTAL_ROWS}`);
    }
  }

  const elapsed = Date.now() - t0;
  console.log(`[db] Seeding complete in ${elapsed}ms`);
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}
