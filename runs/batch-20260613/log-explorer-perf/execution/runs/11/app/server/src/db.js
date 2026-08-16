import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { DATA_DIR, TOTAL_ROWS, SEED_BATCH_SIZE } from './config.js';
import { buildRow } from './seed-data.js';

let db = null;

async function createSchema(pg) {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       BIGINT PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );
  `);
}

async function createIndexes(pg) {
  // Ordering index: every query orders by ts DESC (with id as a stable
  // tiebreaker). This backs the base windowed query and keeps deep offsets
  // index-scannable rather than requiring a full sort.
  await pg.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts_id
      ON logs (ts DESC, id DESC);
  `);

  // Severity-equality + ordering: severity filters are exact equality, and
  // results still order by ts DESC. A composite (severity, ts DESC, id DESC)
  // index lets Postgres satisfy filter + order + slice from one index.
  await pg.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_id
      ON logs (severity, ts DESC, id DESC);
  `);

  // Substring search strategy: a trigram GIN index accelerates
  // case-insensitive ILIKE '%term%' matches, turning full-table scans into
  // index-driven candidate lookups.
  try {
    await pg.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await pg.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
        ON logs USING GIN (lower(message) gin_trgm_ops);
    `);
  } catch (err) {
    // pg_trgm may be unavailable in some PGLite builds; fall back to a plain
    // functional index on lower(message) so search is still correct (if less
    // optimal) rather than failing to boot.
    console.warn('[db] pg_trgm unavailable, falling back to functional index:', err.message);
    await pg.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_lower
        ON logs (lower(message));
    `);
  }
}

async function isSeeded(pg) {
  const res = await pg.query(`SELECT COUNT(*)::int AS c FROM logs;`);
  return res.rows[0].c >= TOTAL_ROWS;
}

async function seed(pg) {
  const started = Date.now();
  console.log(`[db] seeding ${TOTAL_ROWS} rows in batches of ${SEED_BATCH_SIZE}...`);

  // Truncate first in case a previous partial seed was interrupted.
  await pg.exec(`TRUNCATE logs;`);

  for (let start = 0; start < TOTAL_ROWS; start += SEED_BATCH_SIZE) {
    const end = Math.min(start + SEED_BATCH_SIZE, TOTAL_ROWS);
    const values = [];
    const params = [];
    let p = 0;
    for (let i = start; i < end; i++) {
      const r = buildRow(i);
      values.push(`($${++p}, $${++p}, $${++p}, $${++p}, $${++p})`);
      params.push(i, r.ts.toISOString(), r.severity, r.service, r.message);
    }
    await pg.query(
      `INSERT INTO logs (id, ts, severity, service, message) VALUES ${values.join(',')};`,
      params,
    );
  }

  await pg.exec(`ANALYZE logs;`);
  console.log(`[db] seed complete in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

export async function getDb() {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const pg = new PGlite(DATA_DIR);
  await pg.waitReady;

  await createSchema(pg);

  const seeded = await isSeeded(pg);
  if (!seeded) {
    await seed(pg);
  } else {
    console.log('[db] corpus already present, skipping seed');
  }

  // Ensure indexes exist regardless of seed path (idempotent).
  await createIndexes(pg);

  db = pg;
  return db;
}
