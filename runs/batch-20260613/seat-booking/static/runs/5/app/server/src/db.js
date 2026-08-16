/**
 * Database layer – PGLite initialisation, schema creation, and seeding.
 *
 * PGLite is a single-writer embedded Postgres.  All mutations go through
 * the `withTx` helper which serialises work inside an explicit transaction.
 *
 * Because Node.js is single-threaded but async, two concurrent request
 * handlers can interleave their awaits.  We use a simple promise-chain
 * mutex so that only one `withTx` body runs at a time, preventing
 * interleaved BEGIN/COMMIT pairs.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data/pglite');

// ── singleton ──────────────────────────────────────────────────────────────
let _db = null;

export function getDb() {
  if (!_db) throw new Error('Database not initialised – call initDb() first');
  return _db;
}

// ── schema & seed ──────────────────────────────────────────────────────────
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
const HOLD_TTL_SECONDS = 60;

export { HOLD_TTL_SECONDS };

async function createSchema(db) {
  await db.exec(`
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
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT        NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      confirmed   BOOLEAN     NOT NULL DEFAULT FALSE
    );

    CREATE INDEX IF NOT EXISTS idx_seats_hold_id   ON seats (hold_id);
    CREATE INDEX IF NOT EXISTS idx_seats_status    ON seats (status);
    CREATE INDEX IF NOT EXISTS idx_holds_expires   ON holds (expires_at);
  `);
}

async function seedSeats(db) {
  // Only seed when the table is empty so restarts are idempotent.
  const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM seats');
  if (Number(rows[0].cnt) > 0) return;

  const values = [];
  for (const row of ROWS) {
    for (let s = 1; s <= SEATS_PER_ROW; s++) {
      const id = `${row}${s}`;
      values.push(`('${id}', '${row}', ${s}, 'available')`);
    }
  }
  await db.exec(
    `INSERT INTO seats (id, row_label, seat_number, status) VALUES ${values.join(',')}`
  );
}

// ── public init ────────────────────────────────────────────────────────────
export async function initDb() {
  _db = new PGlite(DATA_DIR);
  // PGLite v0.2+ exposes `ready` as a Promise; older versions used `waitReady`.
  await (_db.ready ?? _db.waitReady);
  await createSchema(_db);
  await seedSeats(_db);
  console.log('[db] PGLite ready at', DATA_DIR);
  return _db;
}

// ── Serialising mutex ──────────────────────────────────────────────────────
/**
 * A simple promise-chain mutex.  Every call to `withTx` is appended to the
 * chain so that transactions never interleave, even under concurrent async
 * request handlers.
 */
let _txChain = Promise.resolve();

/**
 * Run `fn(db)` inside a serialisable transaction.
 *
 * Guarantees:
 *  - Only one `fn` body executes at a time (mutex via promise chain).
 *  - The transaction is rolled back if `fn` throws.
 *
 * @template T
 * @param {(db: import('@electric-sql/pglite').PGlite) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withTx(fn) {
  // Append to the chain; each call waits for the previous to finish.
  const next = _txChain.then(async () => {
    const db = getDb();
    await db.exec('BEGIN');
    try {
      const result = await fn(db);
      await db.exec('COMMIT');
      return result;
    } catch (err) {
      try { await db.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
      throw err;
    }
  });

  // Update the chain pointer.  We attach a no-op catch so that a rejected
  // transaction doesn't poison the chain for subsequent callers.
  _txChain = next.catch(() => {});

  return next;
}
