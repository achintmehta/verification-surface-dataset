/**
 * Database initialization and helper utilities using PGLite.
 *
 * PGLite is an embedded PostgreSQL engine that runs inside Node.js.
 * We persist data to the local filesystem so state survives restarts.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data/pglite');

// Hold TTL in seconds – seats are released if a hold is not confirmed within this window.
// Can be overridden via the HOLD_TTL_SECONDS environment variable (useful for testing).
export const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS ?? '60', 10);

// Seat map dimensions
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

let _db = null;

/**
 * Return the singleton PGLite instance, initialising it on first call.
 */
export async function getDb() {
  if (_db) return _db;

  _db = new PGlite(`file://${DATA_DIR}`);
  await _db.waitReady;
  await initSchema(_db);
  return _db;
}

/**
 * Create tables and seed the seat map if they do not already exist.
 */
async function initSchema(db) {
  // Create the seats table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id              TEXT PRIMARY KEY,
      row_label       TEXT        NOT NULL,
      seat_number     INTEGER     NOT NULL,
      status          TEXT        NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available', 'held', 'booked')),
      hold_id         TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by       TEXT,
      UNIQUE (row_label, seat_number)
    );
  `);

  // Create the holds table – a hold groups one or more seats under a single token
  await db.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT        NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      confirmed   BOOLEAN     NOT NULL DEFAULT FALSE,
      seat_ids    TEXT[]      NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed the seat map only if the table is empty
  const { rows } = await db.query(`SELECT COUNT(*) AS cnt FROM seats`);
  const count = parseInt(rows[0].cnt, 10);

  if (count === 0) {
    const values = [];
    const params = [];
    let idx = 1;

    for (const row of ROWS) {
      for (let s = 1; s <= SEATS_PER_ROW; s++) {
        const id = `${row}${s}`;
        values.push(`($${idx++}, $${idx++}, $${idx++})`);
        params.push(id, row, s);
      }
    }

    await db.query(
      `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')}`,
      params
    );

    console.log(`[db] Seeded ${ROWS.length * SEATS_PER_ROW} seats.`);
  }
}

/**
 * Generate a simple random token suitable for hold / booking IDs.
 */
export function generateId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
