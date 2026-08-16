import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBatches, TOTAL_ROWS } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Persist to the local filesystem so restarts do not reseed.
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

let db = null;

export const VALID_SEVERITIES = ['debug', 'info', 'warn', 'error'];

async function tableIsSeeded(pg) {
  // Detect whether the logs table exists and holds the full corpus.
  const existsRes = await pg.query(
    `SELECT to_regclass('public.logs') IS NOT NULL AS present`
  );
  if (!existsRes.rows[0] || !existsRes.rows[0].present) return false;
  const countRes = await pg.query(`SELECT COUNT(*)::int AS c FROM logs`);
  return countRes.rows[0].c >= TOTAL_ROWS;
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
  // Ordering index (newest first is our default query shape).
  await pg.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);`);
  // Severity equality + ordering.
  await pg.exec(
    `CREATE INDEX IF NOT EXISTS idx_logs_sev_ts ON logs (severity, ts DESC, id DESC);`
  );
  // Substring search strategy: trigram GIN index on lowercased message.
  // Fall back gracefully if pg_trgm is unavailable.
  try {
    await pg.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await pg.exec(
      `CREATE INDEX IF NOT EXISTS idx_logs_msg_trgm ON logs USING gin (lower(message) gin_trgm_ops);`
    );
  } catch (err) {
    // If trigram support is missing, substring search still works via scan;
    // ordering/severity indexes keep the common paths fast.
    console.warn('pg_trgm not available, substring search will use a scan:', err.message);
  }
}

async function seedCorpus(pg) {
  const t0 = Date.now();
  console.log(`Seeding ${TOTAL_ROWS} log rows...`);
  await pg.exec('BEGIN');
  try {
    for (const batch of generateBatches()) {
      // Build a single multi-row INSERT with parameters.
      const values = [];
      const params = [];
      let p = 1;
      for (const row of batch) {
        values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(row.ts, row.severity, row.service, row.message);
      }
      await pg.query(
        `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')}`,
        params
      );
    }
    await pg.exec('COMMIT');
  } catch (err) {
    await pg.exec('ROLLBACK');
    throw err;
  }
  console.log(`Seed complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

export async function initDb() {
  if (db) return db;
  const pg = new PGlite(DATA_DIR);
  await pg.waitReady;

  await createSchema(pg);

  const seeded = await tableIsSeeded(pg);
  if (!seeded) {
    // Ensure a clean slate in case of a partial prior seed.
    await pg.exec('TRUNCATE logs RESTART IDENTITY');
    await seedCorpus(pg);
    await createIndexes(pg);
    await pg.exec('ANALYZE logs');
  } else {
    // Table already populated; make sure indexes still exist (cheap no-ops).
    await createIndexes(pg);
  }

  db = pg;
  return db;
}

export function getDb() {
  if (!db) throw new Error('DB not initialized');
  return db;
}
