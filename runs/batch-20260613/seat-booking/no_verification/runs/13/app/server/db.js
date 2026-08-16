// PGLite database initialization and seeding.
import { PGlite } from '@electric-sql/pglite';
import { config, rowLabel } from './config.js';

let db = null;

/**
 * Initialize PGLite (persisted to local disk), create the schema, and seed the
 * fixed seat map if it has not yet been seeded.
 */
export async function initDb() {
  if (db) return db;

  db = new PGlite(config.dataDir);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id              SERIAL PRIMARY KEY,
      row_label       TEXT NOT NULL,
      seat_number     INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available', 'held', 'booked')),
      hold_id         TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by       TEXT,
      UNIQUE (row_label, seat_number)
    );

    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats (hold_id);
    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats (status);
  `);

  await seedSeats();

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

/**
 * Seed the fixed seat map (rows × seatsPerRow). Idempotent: only inserts seats
 * that do not yet exist, so restarts preserve existing state.
 */
async function seedSeats() {
  const { rows: countRows } = await db.query('SELECT COUNT(*)::int AS n FROM seats;');
  const existing = countRows[0].n;

  const expected = config.rows * config.seatsPerRow;
  if (existing >= expected) return;

  await db.transaction(async (tx) => {
    for (let r = 0; r < config.rows; r++) {
      const label = rowLabel(r);
      for (let s = 1; s <= config.seatsPerRow; s++) {
        await tx.query(
          `INSERT INTO seats (row_label, seat_number, status)
           VALUES ($1, $2, 'available')
           ON CONFLICT (row_label, seat_number) DO NOTHING;`,
          [label, s]
        );
      }
    }
  });
}
