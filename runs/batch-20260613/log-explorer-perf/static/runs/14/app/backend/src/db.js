// PGLite initialization, schema, indexes, and one-time seeding.
import { PGlite } from '@electric-sql/pglite';
import { DB_DIR, TOTAL_ROWS, SEED_BATCH_SIZE } from './config.js';
import { rowBatches } from './seed.js';

let db = null;

/**
 * Returns the shared PGLite instance, creating and initializing it on first call.
 * Persists to the local filesystem (DB_DIR) so restarts do not lose data.
 */
export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_DIR);
  await db.waitReady;
  await initSchema(db);
  await ensureSeeded(db);
  return db;
}

async function initSchema(pg) {
  // Table + supporting indexes are idempotent (IF NOT EXISTS), so schema setup
  // is safe on every boot.
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       INTEGER PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );

    -- Ordering index: every query orders by ts DESC, id DESC. A composite index
    -- on (ts DESC, id DESC) lets Postgres read windows in order without a sort.
    CREATE INDEX IF NOT EXISTS logs_ts_id_desc_idx ON logs (ts DESC, id DESC);

    -- Severity equality + ordering: covers the severity-filtered query shape.
    CREATE INDEX IF NOT EXISTS logs_sev_ts_id_idx ON logs (severity, ts DESC, id DESC);

    -- Substring search strategy: a trigram GIN index accelerates ILIKE '%q%'.
    -- Requires the pg_trgm extension (bundled with PGLite's Postgres core).
  `);

  // pg_trgm may not be available in every PGLite build; enable defensively.
  try {
    await pg.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await pg.exec(
      `CREATE INDEX IF NOT EXISTS logs_message_trgm_idx
         ON logs USING GIN (message gin_trgm_ops);`
    );
  } catch (err) {
    // Fall back gracefully: substring search still works via sequential ILIKE,
    // just without trigram acceleration.
    // eslint-disable-next-line no-console
    console.warn(
      '[db] pg_trgm trigram index unavailable, substring search will be slower:',
      err && err.message ? err.message : err
    );
  }
}

async function isSeeded(pg) {
  const res = await pg.query('SELECT COUNT(*)::int AS c FROM logs;');
  const count = res.rows[0]?.c ?? 0;
  return count >= TOTAL_ROWS;
}

/**
 * Seeds the corpus exactly once. If the table already holds the full corpus,
 * seeding is skipped entirely (fast subsequent boots).
 */
async function ensureSeeded(pg) {
  if (await isSeeded(pg)) {
    // eslint-disable-next-line no-console
    console.log('[db] corpus already present, skipping seed');
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[db] seeding ${TOTAL_ROWS} rows...`);
  const startedAt = Date.now();

  // Clear any partial seed from an interrupted prior boot.
  await pg.exec('TRUNCATE logs;');

  for (const batch of rowBatches(SEED_BATCH_SIZE)) {
    // Build a single multi-row INSERT with parameter placeholders for the batch.
    const values = [];
    const params = [];
    let p = 1;
    for (const row of batch) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(row.id, row.ts, row.severity, row.service, row.message);
    }
    await pg.query(
      `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')};`,
      params
    );
  }

  // Keep planner statistics fresh so index usage is chosen correctly.
  await pg.exec('ANALYZE logs;');

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  // eslint-disable-next-line no-console
  console.log(`[db] seeding complete in ${secs}s`);
}
