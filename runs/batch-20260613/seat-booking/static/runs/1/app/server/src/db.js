/**
 * Database layer – PGLite initialisation, schema creation, and seeding.
 *
 * PGLite is a single-connection embedded Postgres.  Because it is
 * single-threaded and all async operations are serialised through its
 * internal queue, we get the same "one writer at a time" guarantee that
 * a real Postgres connection pool would give us when we wrap operations
 * in explicit transactions.  We therefore never need a separate mutex:
 * the PGLite promise queue IS the mutex.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data/pglite');

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

let _db = null;

export async function getDb() {
  if (_db) return _db;
  _db = await PGlite.create(`file://${DATA_DIR}`);
  await initSchema(_db);
  return _db;
}

// ---------------------------------------------------------------------------
// Schema & seed
// ---------------------------------------------------------------------------

const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

async function initSchema(db) {
  // Create the seats table if it does not already exist.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id               TEXT        PRIMARY KEY,
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
      id          TEXT        PRIMARY KEY,
      session_id  TEXT        NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      confirmed   BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_seats_hold_id
      ON seats (hold_id)
      WHERE hold_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_seats_status
      ON seats (status);

    CREATE INDEX IF NOT EXISTS idx_holds_expires_at
      ON holds (expires_at)
      WHERE confirmed = FALSE;
  `);

  // Seed only when the table is empty.
  const { rows } = await db.query(`SELECT COUNT(*) AS cnt FROM seats`);
  if (parseInt(rows[0].cnt, 10) === 0) {
    const values = [];
    for (const row of ROWS) {
      for (let s = 1; s <= SEATS_PER_ROW; s++) {
        const id = `${row}${s}`;
        values.push(`('${id}', '${row}', ${s}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(
      `INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by)
       VALUES ${values.join(',\n')};`
    );
    console.log(`[db] Seeded ${ROWS.length * SEATS_PER_ROW} seats.`);
  }
}
