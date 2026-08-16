import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedLogs } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../data/pglite');

let _db = null;

export async function initDb() {
  if (_db) return _db;

  console.log(`[db] Opening PGLite at ${DB_PATH}`);
  const db = new PGlite(DB_PATH);

  // ── Schema ────────────────────────────────────────────────────────────────
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        BIGINT PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT        NOT NULL,
      service   TEXT        NOT NULL,
      message   TEXT        NOT NULL
    );
  `);

  // ── Indexes ───────────────────────────────────────────────────────────────

  // Primary sort index: (ts DESC, id DESC) — covers ORDER BY ts DESC, id DESC
  // and supports deep-offset scans without heap fetches for the sort key.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts_id ON logs (ts DESC, id DESC);
  `);

  // Severity filter + sort: (severity, ts DESC, id DESC)
  // Covers WHERE severity = ? ORDER BY ts DESC, id DESC
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_id ON logs (severity, ts DESC, id DESC);
  `);

  // ── pg_trgm for fast ILIKE substring search ───────────────────────────────
  let trgmAvailable = false;
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
        ON logs USING GIN (message gin_trgm_ops);
    `);
    trgmAvailable = true;
    console.log('[db] pg_trgm extension enabled — GIN trigram index on message created.');
  } catch (err) {
    console.warn('[db] pg_trgm not available, falling back to sequential ILIKE scan:', err.message);
  }

  // ── Seed check ────────────────────────────────────────────────────────────
  const countResult = await db.query('SELECT COUNT(*) AS cnt FROM logs');
  const existingCount = parseInt(countResult.rows[0].cnt, 10);

  if (existingCount < 100000) {
    console.log(`[db] Found ${existingCount} rows — seeding to 100,000...`);
    const t0 = Date.now();
    await seedLogs(db, existingCount);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[db] Seeding complete in ${elapsed}s`);

    // ANALYZE after bulk insert so the planner has accurate statistics
    console.log('[db] Running ANALYZE...');
    await db.exec('ANALYZE logs;');
    console.log('[db] ANALYZE complete.');
  } else {
    console.log(`[db] Already seeded (${existingCount} rows) — skipping seed.`);
  }

  _db = db;
  return db;
}
