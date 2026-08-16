/**
 * Database schema initialisation and seeding.
 *
 * Runs once at server start-up.  Uses IF NOT EXISTS guards so it is safe to
 * call on every restart against an already-populated database.
 */

import { serialise } from './db.js';

// ---------------------------------------------------------------------------
// Seat map configuration
// ---------------------------------------------------------------------------

export const ROWS = ['A', 'B', 'C', 'D', 'E'];
export const SEATS_PER_ROW = 10;
export const HOLD_TTL_SECONDS = 60; // 1 minute

// ---------------------------------------------------------------------------
// Schema + seed
// ---------------------------------------------------------------------------

export async function initSchema() {
  await serialise(async (db) => {
    // ------------------------------------------------------------------
    // seats table
    // ------------------------------------------------------------------
    await db.query(`
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
      )
    `);

    // ------------------------------------------------------------------
    // holds table  (one row per hold, references many seats)
    // ------------------------------------------------------------------
    await db.query(`
      CREATE TABLE IF NOT EXISTS holds (
        id          TEXT PRIMARY KEY,
        session_id  TEXT        NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        confirmed   BOOLEAN     NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ------------------------------------------------------------------
    // Seed seats if the table is empty
    // ------------------------------------------------------------------
    const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM seats');
    const count = parseInt(rows[0].cnt, 10);

    if (count === 0) {
      for (const row of ROWS) {
        for (let s = 1; s <= SEATS_PER_ROW; s++) {
          const id = `${row}${s}`;
          await db.query(
            `INSERT INTO seats (id, row_label, seat_number, status)
             VALUES ($1, $2, $3, 'available')
             ON CONFLICT DO NOTHING`,
            [id, row, s]
          );
        }
      }
      console.log(`[schema] Seeded ${ROWS.length * SEATS_PER_ROW} seats.`);
    } else {
      console.log(`[schema] Seats table already populated (${count} rows).`);
    }
  });
}
