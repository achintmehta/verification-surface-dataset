import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateRows, SEED_META } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

let db = null;

const SEED_COUNT = SEED_META.count;
const BATCH_ROWS = 2000; // rows per multi-row INSERT statement

async function createSchema(pg) {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       BIGSERIAL PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL,
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );
  `);
}

async function createIndexes(pg) {
  // Ordering by ts descending is the base query shape. id tiebreaker for
  // stable ordering. This index also serves plain "order by ts desc".
  await pg.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts_id ON logs (ts DESC, id DESC);
  `);
  // Severity equality + ordering by ts.
  await pg.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_sev_ts ON logs (severity, ts DESC, id DESC);
  `);
  // Substring / case-insensitive search: trigram index over lower(message).
  await pg.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`).catch(() => {
    // pg_trgm may be unavailable; the query still works via ILIKE, just slower.
  });
  await pg
    .exec(`CREATE INDEX IF NOT EXISTS idx_logs_msg_trgm ON logs USING gin (lower(message) gin_trgm_ops);`)
    .catch(() => {});
  await pg.exec(`ANALYZE logs;`);
}

async function isSeeded(pg) {
  const res = await pg.query('SELECT COUNT(*)::int AS n FROM logs;');
  return res.rows[0].n >= SEED_COUNT;
}

async function seed(pg) {
  const started = Date.now();
  console.log(`[db] seeding ${SEED_COUNT} rows...`);

  await pg.exec('BEGIN;');
  try {
    let batch = [];
    let done = 0;

    const flush = async () => {
      if (batch.length === 0) return;
      const placeholders = [];
      const params = [];
      let p = 1;
      for (const row of batch) {
        placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(row[0], row[1], row[2], row[3]);
      }
      await pg.query(
        `INSERT INTO logs (ts, severity, service, message) VALUES ${placeholders.join(',')};`,
        params
      );
      done += batch.length;
      batch = [];
      if (done % 20000 === 0) console.log(`[db]   seeded ${done}/${SEED_COUNT}`);
    };

    for (const row of generateRows(SEED_COUNT)) {
      batch.push(row);
      if (batch.length >= BATCH_ROWS) await flush();
    }
    await flush();

    await pg.exec('COMMIT;');
  } catch (err) {
    await pg.exec('ROLLBACK;');
    throw err;
  }

  console.log(`[db] seeding complete in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

export async function initDb() {
  if (db) return db;
  const started = Date.now();
  db = new PGlite(DATA_DIR);
  await db.waitReady;

  await createSchema(db);

  if (!(await isSeeded(db))) {
    await seed(db);
  } else {
    console.log('[db] existing corpus detected, skipping seed');
  }

  await createIndexes(db);

  console.log(`[db] ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return db;
}

export function getDb() {
  if (!db) throw new Error('DB not initialized');
  return db;
}
