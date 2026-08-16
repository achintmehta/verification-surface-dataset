/**
 * db.js – PGLite initialisation, schema creation, and seat seeding.
 *
 * We use a single PGLite instance (embedded Postgres) persisted to disk.
 * All SQL is executed through a thin helper that serialises concurrent
 * calls through a promise-chain mutex so that PGLite's single-writer
 * model is never violated.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data', 'pglite');

// ── Seat map configuration ────────────────────────────────────────────────────
export const ROWS = ['A', 'B', 'C', 'D', 'E'];
export const SEATS_PER_ROW = 10;
export const HOLD_TTL_SECONDS = 60; // 60-second hold window

// ── PGLite singleton ──────────────────────────────────────────────────────────
let _db = null;

/**
 * Returns the initialised PGLite instance (creates it on first call).
 */
export async function getDb() {
  if (_db) return _db;
  _db = new PGlite(DATA_DIR);
  await _db.waitReady;
  return _db;
}

// ── Serialisation mutex ───────────────────────────────────────────────────────
// PGLite is single-writer; we serialise every query through a promise chain
// so concurrent Express handlers never overlap inside PGLite.
let _tail = Promise.resolve();

/**
 * Run `fn(db)` exclusively – no two calls overlap inside PGLite.
 */
export function withDb(fn) {
  const next = _tail.then(async () => {
    const db = await getDb();
    return fn(db);
  });
  // Swallow errors on the shared tail so one failure doesn't block the queue.
  _tail = next.catch(() => {});
  return next;
}

// ── Schema & seed ─────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS seats (
  id               TEXT PRIMARY KEY,
  row_label        TEXT NOT NULL,
  seat_number      INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'available'
                     CHECK (status IN ('available','held','booked')),
  hold_id          TEXT,
  hold_expires_at  TIMESTAMPTZ,
  booked_by        TEXT
);

CREATE TABLE IF NOT EXISTS holds (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seats_hold_id  ON seats(hold_id);
CREATE INDEX IF NOT EXISTS idx_seats_status   ON seats(status);
CREATE INDEX IF NOT EXISTS idx_holds_expires  ON holds(expires_at);
`;

/**
 * Initialise schema and seed the seat map if the table is empty.
 */
export async function initDb() {
  await withDb(async (db) => {
    await db.exec(SCHEMA_SQL);

    // Seed only when the table is empty
    const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM seats');
    if (parseInt(rows[0].cnt, 10) > 0) return;

    const inserts = [];
    for (const row of ROWS) {
      for (let s = 1; s <= SEATS_PER_ROW; s++) {
        const id = `${row}${s}`;
        inserts.push(`('${id}', '${row}', ${s}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(
      `INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by)
       VALUES ${inserts.join(',\n')};`
    );
    console.log(`[db] Seeded ${inserts.length} seats.`);
  });
}
