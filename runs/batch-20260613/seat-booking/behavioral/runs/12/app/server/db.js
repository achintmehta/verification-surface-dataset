import { PGlite } from '@electric-sql/pglite';
import { ROWS, SEATS_PER_ROW } from './config.js';

// Schema for the booking system.
//
//   seats              one row per physical seat, holds the *effective* state
//   holds              one row per hold (a group of seats acquired together)
//
// A seat is only ever associated with at most one *active* hold. The seat row
// carries denormalised hold info (hold_id, hold_expires_at) so the all-or-nothing
// acquisition can be expressed as a single conditional UPDATE.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS seats (
  id              TEXT PRIMARY KEY,
  row_label       TEXT NOT NULL,
  seat_number     INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available', 'held', 'booked')),
  hold_id         TEXT,
  hold_expires_at TIMESTAMPTZ,
  booked_by       TEXT
);

CREATE TABLE IF NOT EXISTS holds (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_seats_status ON seats (status);
CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats (hold_id);
CREATE INDEX IF NOT EXISTS idx_seats_expires ON seats (hold_expires_at);
`;

/**
 * Create and initialise a PGlite database: apply schema and seed the fixed
 * seat map. Safe to call repeatedly; seeding is idempotent.
 *
 * @param {string} [dataDir] PGLite location. Pass 'memory://' or omit for an
 *   ephemeral in-memory db.
 */
export async function initDb(dataDir) {
  const inMemory = !dataDir || dataDir === 'memory://' || dataDir === 'memory';
  const db = inMemory ? new PGlite() : new PGlite(dataDir);
  await db.exec(SCHEMA_SQL);
  await seedSeats(db);
  return db;
}

async function seedSeats(db) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (rows[0].count > 0) return;

  await db.transaction(async (tx) => {
    for (const row of ROWS) {
      for (let n = 1; n <= SEATS_PER_ROW; n++) {
        const id = `${row}${n}`;
        await tx.query(
          'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)',
          [id, row, n, 'available']
        );
      }
    }
  });
}
