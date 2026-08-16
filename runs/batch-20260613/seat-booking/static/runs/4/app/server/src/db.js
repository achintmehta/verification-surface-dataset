/**
 * Database module – initialises PGLite and exposes a single `query` helper
 * that serialises all SQL through a promise queue so the single-connection
 * embedded database is never called concurrently (PGLite does not support
 * concurrent queries on the same instance).
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data/pglite');

// ---------------------------------------------------------------------------
// Serialised query queue
// ---------------------------------------------------------------------------

let _db = null;

/** @type {Array<() => void>} */
let _queue = [];
let _running = false;

async function _drain() {
  if (_running) return;
  _running = true;
  while (_queue.length > 0) {
    const task = _queue.shift();
    await task();
  }
  _running = false;
}

/**
 * Execute a SQL statement with optional parameters.
 * All calls are serialised through a FIFO queue so PGLite never receives
 * overlapping requests.
 *
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<import('@electric-sql/pglite').Results>}
 */
export function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    _queue.push(async () => {
      try {
        const result = await _db.query(sql, params);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
    _drain();
  });
}

/**
 * Execute multiple SQL statements inside a single serialised transaction.
 * `fn` receives a `tx` object with a `query(sql, params)` method that runs
 * inside the transaction.
 *
 * @template T
 * @param {(tx: { query: (sql: string, params?: unknown[]) => Promise<import('@electric-sql/pglite').Results> }) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function transaction(fn) {
  return new Promise((resolve, reject) => {
    _queue.push(async () => {
      try {
        const result = await _db.transaction(async (tx) => {
          return fn({
            query: (sql, params = []) => tx.query(sql, params),
          });
        });
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
    _drain();
  });
}

// ---------------------------------------------------------------------------
// Schema & seed
// ---------------------------------------------------------------------------

const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS seats (
      id               TEXT PRIMARY KEY,
      row_label        TEXT        NOT NULL,
      seat_number      INTEGER     NOT NULL,
      status           TEXT        NOT NULL DEFAULT 'available'
                         CHECK (status IN ('available','held','booked')),
      hold_id          TEXT,
      hold_expires_at  TIMESTAMPTZ,
      booked_by        TEXT,
      UNIQUE (row_label, seat_number)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT        NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      confirmed   BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Seed seats only if the table is empty
  const { rows } = await query('SELECT COUNT(*) AS cnt FROM seats');
  const count = parseInt(rows[0].cnt, 10);
  if (count === 0) {
    for (const row of ROWS) {
      for (let s = 1; s <= SEATS_PER_ROW; s++) {
        const id = `${row}${s}`;
        await query(
          `INSERT INTO seats (id, row_label, seat_number, status)
           VALUES ($1, $2, $3, 'available')
           ON CONFLICT DO NOTHING`,
          [id, row, s]
        );
      }
    }
    console.log(`Seeded ${ROWS.length * SEATS_PER_ROW} seats.`);
  }
}

// ---------------------------------------------------------------------------
// Public init
// ---------------------------------------------------------------------------

export async function initDb() {
  _db = new PGlite(DATA_DIR);
  await _db.waitReady;
  await initSchema();
  console.log('PGLite ready at', DATA_DIR);
}
