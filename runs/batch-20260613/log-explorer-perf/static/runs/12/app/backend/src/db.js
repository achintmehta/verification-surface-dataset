// PGLite initialization, schema, indexes, and one-time seeding.
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import {
  DATA_DIR,
  SEED_ROW_COUNT,
  SEED_BATCH_SIZE,
} from './config.js';
import { forEachBatch } from './corpus.js';

let db = null;

// Whether the trigram extension is available in this PGLite build. If it is
// not, we fall back to a plain ILIKE (still correct, just relies on the
// ordering index + scan for substring queries).
let trigramAvailable = false;

/**
 * Return the singleton PGLite instance, initializing (and seeding on first
 * boot) if necessary.
 */
export async function getDb() {
  if (db) return db;
  db = await PGlite.create(DATA_DIR, {
    extensions: { pg_trgm },
  });
  await initSchema(db);
  await ensureSeeded(db);
  return db;
}

async function initSchema(pg) {
  // Table + ordering/severity indexes are created idempotently. Creating them
  // on every boot is cheap (IF NOT EXISTS) and guarantees the shapes exist even
  // after a manual data reset.
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       BIGSERIAL PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );

    -- Ordering index: every query orders by ts DESC (id as tiebreaker for
    -- stable, deterministic ordering when timestamps collide).
    CREATE INDEX IF NOT EXISTS idx_logs_ts_id ON logs (ts DESC, id DESC);

    -- Severity + ordering: severity-equality filters ordered by ts.
    CREATE INDEX IF NOT EXISTS idx_logs_sev_ts_id ON logs (severity, ts DESC, id DESC);
  `);

  // Substring search strategy: a trigram GIN index accelerates case-insensitive
  // substring (LIKE '%term%') matching over lower(message). If the pg_trgm
  // extension is unavailable in this PGLite build, degrade gracefully to a
  // plain scan (still correct).
  try {
    await pg.exec(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE INDEX IF NOT EXISTS idx_logs_msg_trgm
        ON logs USING GIN (lower(message) gin_trgm_ops);
    `);
    trigramAvailable = true;
  } catch (err) {
    trigramAvailable = false;
    console.warn(
      '[db] pg_trgm unavailable; substring search will use a plain scan:',
      err.message
    );
  }
}

/** Expose whether the trigram index is in play (for diagnostics/tests). */
export function isTrigramAvailable() {
  return trigramAvailable;
}

/**
 * Detect whether the corpus is already populated; seed in batches only if not.
 */
async function ensureSeeded(pg) {
  const res = await pg.query('SELECT COUNT(*)::int AS n FROM logs;');
  const existing = res.rows[0]?.n ?? 0;

  if (existing >= SEED_ROW_COUNT) {
    // Already seeded on a prior boot: skip. Survives restarts without reseed.
    return;
  }

  if (existing > 0) {
    // Partial/inconsistent state (e.g. crash mid-seed). Reset and reseed to
    // guarantee an exact, complete corpus.
    await pg.exec('TRUNCATE logs RESTART IDENTITY;');
  }

  const seedStart = Date.now();
  console.log(`[seed] seeding ${SEED_ROW_COUNT} rows in batches of ${SEED_BATCH_SIZE}...`);

  // A single transaction around all batches avoids per-batch commit overhead
  // and keeps the seed atomic: either the full corpus lands or none of it.
  await pg.exec('BEGIN;');
  try {
    await forEachBatch(SEED_BATCH_SIZE, async (rows) => {
      await insertBatch(pg, rows);
    });
    await pg.exec('COMMIT;');
  } catch (err) {
    await pg.exec('ROLLBACK;');
    throw err;
  }

  // Update planner statistics after the bulk load so index choices are good.
  await pg.exec('ANALYZE logs;');

  console.log(`[seed] done in ${((Date.now() - seedStart) / 1000).toFixed(1)}s`);
}

/**
 * Insert one batch with a single multi-row INSERT for speed.
 */
async function insertBatch(pg, rows) {
  const params = [];
  const valueTuples = [];
  let p = 1;
  for (const row of rows) {
    valueTuples.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
    params.push(row.ts.toISOString(), row.severity, row.service, row.message);
  }
  const sql =
    'INSERT INTO logs (ts, severity, service, message) VALUES ' +
    valueTuples.join(', ') +
    ';';
  await pg.query(sql, params);
}
