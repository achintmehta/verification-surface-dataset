// Embedded PGLite lifecycle: open, migrate schema/indexes, seed once.
import { PGlite } from '@electric-sql/pglite';
import { config } from './config.js';
import { generateBatches } from './seedData.js';

let db = null;

/**
 * Open (or create) the on-disk PGLite database, ensure schema + indexes, and
 * seed the corpus if — and only if — the table is empty. Returns the live
 * PGlite instance.
 */
export async function initDb() {
  const t0 = Date.now();
  db = new PGlite(config.dbDir);
  await db.waitReady;

  await createSchema(db);

  const seeded = await isSeeded(db);
  if (!seeded) {
    console.log('[db] empty corpus detected — seeding %d rows...', config.seed.totalRows);
    await seed(db);
    console.log('[db] seed complete in %dms', Date.now() - t0);
  } else {
    console.log('[db] existing corpus detected — skipping seed (%dms)', Date.now() - t0);
  }

  // Indexes are created after seeding for a fresh DB (faster bulk load), but
  // createIndexes is idempotent so it's safe to call every boot.
  await createIndexes(db);

  // Keep the planner honest at full volume.
  await db.exec('ANALYZE logs;');

  console.log('[db] ready in %dms total', Date.now() - t0);
  return db;
}

async function createSchema(pg) {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       BIGSERIAL PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );
  `);
}

async function createIndexes(pg) {
  // Query shape 1: order by ts DESC (also covers deep-offset windowing).
  // Composite (ts, id) gives a strict total order so ties never shuffle across
  // pages — essential for the "row at offset K is stable" guarantee.
  await pg.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts_id ON logs (ts DESC, id DESC);');

  // Query shape 2: severity equality + ordering by ts.
  await pg.exec('CREATE INDEX IF NOT EXISTS idx_logs_sev_ts_id ON logs (severity, ts DESC, id DESC);');

  // Query shape 3: case-insensitive substring search. A trigram GIN index makes
  // ILIKE '%term%' index-backed instead of a full scan on every keystroke.
  // pg_trgm ships with PGLite's contrib set.
  try {
    await pg.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    await pg.exec(
      'CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (lower(message) gin_trgm_ops);'
    );
  } catch (err) {
    // If pg_trgm is unavailable in this PGLite build, fall back gracefully:
    // ILIKE still works correctly, just without index acceleration.
    console.warn('[db] pg_trgm unavailable, substring search will use scans:', err.message);
  }
}

async function isSeeded(pg) {
  // Cheap existence check: does at least one row exist?
  const res = await pg.query('SELECT EXISTS (SELECT 1 FROM logs LIMIT 1) AS present;');
  return Boolean(res.rows[0] && res.rows[0].present);
}

async function seed(pg) {
  const { batchSize } = config.seed;
  let inserted = 0;

  for (const batch of generateBatches(batchSize)) {
    // Build a single multi-row INSERT for the batch. Parameterized to stay safe
    // and let the engine plan the bulk insert efficiently.
    const values = [];
    const params = [];
    let p = 1;
    for (const row of batch) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(row.ts, row.severity, row.service, row.message);
    }
    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')}`;
    await pg.query(sql, params);
    inserted += batch.length;
    if (inserted % 20_000 === 0) {
      console.log('[db] seeded %d / %d rows', inserted, config.seed.totalRows);
    }
  }
}

export function getDb() {
  if (!db) throw new Error('Database not initialized — call initDb() first.');
  return db;
}
