/**
 * Database module: initializes PGLite, creates schema, seeds seat map.
 *
 * Design notes:
 *  - PGLite is single-connection embedded Postgres; all queries run serially
 *    through a mutex so we never interleave transactions.
 *  - The mutex is a simple promise-chain queue: every caller appends to the
 *    tail and awaits its turn, guaranteeing FIFO serial execution.
 *  - Seat status is stored as a plain TEXT column with a CHECK constraint;
 *    the three legal values are 'available', 'held', 'booked'.
 *  - hold_expires_at is stored as a TIMESTAMPTZ so Postgres arithmetic works.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data/pglite');

// ---------------------------------------------------------------------------
// PGLite singleton
// ---------------------------------------------------------------------------
let _db = null;

export async function getDb() {
  if (_db) return _db;
  _db = new PGlite(DATA_DIR);
  await _db.waitReady;
  return _db;
}

// ---------------------------------------------------------------------------
// Mutex – serialises all DB access so transactions are never interleaved.
// ---------------------------------------------------------------------------
let _tail = Promise.resolve();

/**
 * Run `fn` exclusively: waits for all previously enqueued work to finish,
 * then runs `fn`, then releases the lock for the next waiter.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withLock(fn) {
  // Append fn to the tail of the promise chain.
  // Each step ignores the previous result/error so the chain never breaks.
  const next = _tail.then(() => fn());
  // The new tail swallows errors so a failed fn doesn't block later callers.
  _tail = next.then(
    () => {},
    () => {},
  );
  return next;
}

// ---------------------------------------------------------------------------
// Schema & seed
// ---------------------------------------------------------------------------
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
export const HOLD_TTL_SECONDS = 60; // 1 minute

export async function initDb() {
  const db = await getDb();

  await withLock(async () => {
    // Create seats table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS seats (
        id               TEXT PRIMARY KEY,
        row_label        TEXT NOT NULL,
        seat_number      INTEGER NOT NULL,
        status           TEXT NOT NULL DEFAULT 'available'
                           CHECK (status IN ('available','held','booked')),
        hold_id          TEXT,
        hold_expires_at  TIMESTAMPTZ,
        booked_by        TEXT,
        UNIQUE (row_label, seat_number)
      );
    `);

    // Create holds table for idempotent confirmation tracking
    await db.exec(`
      CREATE TABLE IF NOT EXISTS holds (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at   TIMESTAMPTZ NOT NULL,
        confirmed_at TIMESTAMPTZ,
        released_at  TIMESTAMPTZ
      );
    `);

    // Seed seats only if the table is empty
    const { rows } = await db.query(`SELECT COUNT(*) AS cnt FROM seats`);
    const count = parseInt(rows[0].cnt, 10);

    if (count === 0) {
      const values = [];
      const params = [];
      let p = 1;
      for (const row of ROWS) {
        for (let s = 1; s <= SEATS_PER_ROW; s++) {
          const id = `${row}${s}`;
          values.push(`($${p++}, $${p++}, $${p++})`);
          params.push(id, row, s);
        }
      }
      await db.query(
        `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')}`,
        params,
      );
      console.log(`[db] Seeded ${ROWS.length * SEATS_PER_ROW} seats.`);
    } else {
      console.log(`[db] Found ${count} existing seats – skipping seed.`);
    }
  });

  console.log('[db] Database ready.');
}
