import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persistent data directory so the corpus survives restarts.
const DATA_DIR = process.env.PGLITE_DIR
  ? path.resolve(process.env.PGLITE_DIR)
  : path.resolve(__dirname, '..', 'pgdata');

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];
export const TOTAL_ROWS = 100_000;

let db = null;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  return db;
}

/**
 * Create the schema (idempotent). Table + indexes tuned for the two query
 * shapes: severity equality + order by ts, and substring match + order by ts.
 */
export async function ensureSchema() {
  const d = await getDb();
  await d.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        BIGINT PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service   TEXT NOT NULL,
      message   TEXT NOT NULL
    );
  `);
}

/**
 * Create indexes. Done after the seed so the bulk load is not slowed by index
 * maintenance. Idempotent.
 */
export async function ensureIndexes({ trigram = false } = {}) {
  const d = await getDb();
  // Ordering index: unfiltered windowed scans order by ts desc, id desc.
  await d.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts_id ON logs (ts DESC, id DESC);`);
  // Severity equality + ordering.
  await d.exec(`CREATE INDEX IF NOT EXISTS idx_logs_sev_ts_id ON logs (severity, ts DESC, id DESC);`);

  // Substring search: trigram index for case-insensitive LIKE '%term%'.
  // Only attempt if pg_trgm is available; otherwise LIKE falls back to a scan
  // (still within budget on 100k rows).
  if (trigram) {
    try {
      await d.exec(`
        CREATE INDEX IF NOT EXISTS idx_logs_msg_trgm
          ON logs USING gin (lower(message) gin_trgm_ops);
      `);
    } catch (err) {
      console.warn('[db] trigram index unavailable, using scan for substring search:', err.message);
    }
  }
}

export async function tryEnableTrigram() {
  const d = await getDb();
  try {
    await d.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    return true;
  } catch {
    return false;
  }
}

/** How many rows are already seeded. */
export async function seededCount() {
  const d = await getDb();
  const res = await d.query('SELECT COUNT(*)::int AS c FROM logs');
  return res.rows[0].c;
}

export { DATA_DIR };
