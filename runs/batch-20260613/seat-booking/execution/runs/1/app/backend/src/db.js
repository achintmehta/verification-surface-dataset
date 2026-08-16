/**
 * db.js – PGLite initialisation, schema creation, and seed data.
 *
 * PGLite is an embedded PostgreSQL running inside Node.js.  We persist the
 * database to the local filesystem so state survives server restarts.
 *
 * IMPORTANT: PGLite is single-connection by design.  All callers share the
 * one `db` instance exported here and must never open a second one against
 * the same data directory.  Concurrency is serialised through the single
 * async queue that PGLite maintains internally.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data', 'pglite');

// ---------------------------------------------------------------------------
// Seat map configuration
// ---------------------------------------------------------------------------
export const ROWS = ['A', 'B', 'C', 'D', 'E'];
export const SEATS_PER_ROW = 10;
export const HOLD_TTL_SECONDS = 60; // holds expire after 60 s

// ---------------------------------------------------------------------------
// Singleton PGLite instance
// ---------------------------------------------------------------------------
let _db = null;

export async function getDb() {
  if (_db) return _db;

  _db = new PGlite(DATA_DIR);

  // Wait for PGLite to be ready before running any SQL
  await _db.waitReady;

  await initSchema(_db);
  return _db;
}

// ---------------------------------------------------------------------------
// Schema + seed
// ---------------------------------------------------------------------------
async function initSchema(db) {
  // Create the seats table if it does not already exist.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id               TEXT PRIMARY KEY,
      row_label        TEXT        NOT NULL,
      seat_number      INTEGER     NOT NULL,
      status           TEXT        NOT NULL DEFAULT 'available'
                         CHECK (status IN ('available', 'held', 'booked')),
      hold_id          TEXT,
      hold_expires_at  TIMESTAMPTZ,
      booked_by        TEXT,
      UNIQUE (row_label, seat_number)
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT        NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      confirmed   BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats (hold_id);
    CREATE INDEX IF NOT EXISTS idx_holds_expires ON holds (expires_at);
  `);

  // Seed the seat map only when the table is empty.
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
      params
    );

    console.log(`[db] Seeded ${ROWS.length * SEATS_PER_ROW} seats.`);
  } else {
    console.log(`[db] Found ${count} existing seats – skipping seed.`);
  }
}
