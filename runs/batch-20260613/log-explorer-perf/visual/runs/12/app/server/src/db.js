import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOTAL_ROWS, generateRows } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'pgdata');

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  await ensureSchema();
  await ensureSeed();
  return db;
}

async function ensureSchema() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       BIGSERIAL PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );
  `);
}

async function ensureIndexes() {
  // Ordering by ts desc (with id as tiebreaker for deterministic paging).
  // Composite index supports both the plain ordering and severity-filtered
  // ordering query shapes.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS logs_ts_id_idx ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS logs_sev_ts_id_idx ON logs (severity, ts DESC, id DESC);
  `);
  // Trigram index for substring (ILIKE '%...%') search.
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS logs_message_trgm_idx
        ON logs USING gin (lower(message) gin_trgm_ops);
    `);
  } catch (e) {
    // pg_trgm may be unavailable in the embedded build; substring search
    // will still work correctly (just without the specialized index).
    console.warn('pg_trgm unavailable, falling back to sequential substring search:', e.message);
  }
}

async function isSeeded() {
  const res = await db.query('SELECT COUNT(*)::int AS c FROM logs;');
  return res.rows[0].c >= TOTAL_ROWS;
}

async function ensureSeed() {
  if (await isSeeded()) {
    // Make sure indexes exist even on subsequent boots.
    await ensureIndexes();
    return;
  }
  console.log('Seeding %d log rows...', TOTAL_ROWS);
  const t0 = Date.now();

  // If the table has a partial/leftover population, start clean.
  await db.exec('TRUNCATE logs RESTART IDENTITY;');

  const BATCH = 1000;
  let batch = [];
  let params = [];
  let count = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    // Build multi-row VALUES insert.
    const values = batch
      .map((_, i) => {
        const b = i * 4;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
      })
      .join(',');
    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${values};`,
      params
    );
    batch = [];
    params = [];
  };

  for (const row of generateRows()) {
    batch.push(row);
    params.push(row.ts, row.severity, row.service, row.message);
    count++;
    if (batch.length >= BATCH) {
      await flush();
    }
  }
  await flush();

  console.log('Inserted %d rows in %dms. Building indexes...', count, Date.now() - t0);
  await ensureIndexes();
  await db.exec('ANALYZE logs;');
  console.log('Seed complete in %dms.', Date.now() - t0);
}
