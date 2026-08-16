/**
 * Database schema initialisation and seeding.
 *
 * Creates the `seats` and `holds` tables if they do not already exist, then
 * seeds the fixed seat map (ROWS × SEATS_PER_ROW) when the seats table is
 * empty.
 */

import { query } from './db.js';

// ---------------------------------------------------------------------------
// Seat-map dimensions
// ---------------------------------------------------------------------------

export const ROWS = ['A', 'B', 'C', 'D', 'E'];
export const SEATS_PER_ROW = 10;
export const TOTAL_SEATS = ROWS.length * SEATS_PER_ROW;

/** Hold TTL in seconds */
export const HOLD_TTL_SECONDS = 60;

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const CREATE_HOLDS_TABLE = `
  CREATE TABLE IF NOT EXISTS holds (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
    confirmed_at TIMESTAMPTZ
  );
`;

const CREATE_SEATS_TABLE = `
  CREATE TABLE IF NOT EXISTS seats (
    id               TEXT PRIMARY KEY,
    row_label        TEXT NOT NULL,
    seat_number      INTEGER NOT NULL,
    status           TEXT NOT NULL DEFAULT 'available'
                       CHECK (status IN ('available', 'held', 'booked')),
    hold_id          TEXT REFERENCES holds(id),
    hold_expires_at  TIMESTAMPTZ,
    booked_by        TEXT,
    UNIQUE (row_label, seat_number)
  );
`;

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------

export async function initSchema() {
  // Create tables
  await query(CREATE_HOLDS_TABLE);
  await query(CREATE_SEATS_TABLE);

  // Seed only when empty
  const { rows } = await query('SELECT COUNT(*) AS cnt FROM seats');
  const count = parseInt(rows[0].cnt, 10);
  if (count > 0) {
    console.log(`[schema] seats table already has ${count} rows – skipping seed`);
    return;
  }

  console.log('[schema] seeding seat map …');
  for (const row of ROWS) {
    for (let s = 1; s <= SEATS_PER_ROW; s++) {
      const id = `${row}${s}`;
      await query(
        `INSERT INTO seats (id, row_label, seat_number, status)
         VALUES ($1, $2, $3, 'available')
         ON CONFLICT DO NOTHING`,
        [id, row, s],
      );
    }
  }
  console.log(`[schema] seeded ${TOTAL_SEATS} seats`);
}
