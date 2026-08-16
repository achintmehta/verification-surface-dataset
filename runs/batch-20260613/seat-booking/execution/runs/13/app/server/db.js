import { PGlite } from '@electric-sql/pglite';
import { config, rowLabel } from './config.js';

let db = null;

// Initialise (or open) the embedded PGLite database, create the schema if
// needed, and seed the fixed seat map exactly once.
export async function initDb() {
  if (db) return db;

  db = new PGlite(config.dataDir);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id              SERIAL PRIMARY KEY,
      row_label       TEXT    NOT NULL,
      seat_number     INTEGER NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'available'
                              CHECK (status IN ('available','held','booked')),
      hold_id         TEXT,
      hold_expires_at BIGINT,
      booked_by       TEXT,
      UNIQUE (row_label, seat_number)
    );

    CREATE INDEX IF NOT EXISTS seats_status_idx ON seats (status);
    CREATE INDEX IF NOT EXISTS seats_hold_idx ON seats (hold_id);

    CREATE TABLE IF NOT EXISTS holds (
      hold_id     TEXT PRIMARY KEY,
      session_id  TEXT   NOT NULL,
      expires_at  BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookings (
      booking_id  TEXT PRIMARY KEY,
      hold_id     TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      seat_ids    INTEGER[] NOT NULL,
      created_at  BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
      UNIQUE (hold_id)
    );
  `);

  await seedSeats();

  return db;
}

// Seed the fixed seat map. Idempotent: only inserts seats that are missing,
// so restarting the server preserves existing seat state.
async function seedSeats() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (rows[0].count > 0) return;

  const values = [];
  const params = [];
  let p = 1;
  for (let r = 0; r < config.rows; r++) {
    for (let s = 1; s <= config.seatsPerRow; s++) {
      values.push(`($${p++}, $${p++})`);
      params.push(rowLabel(r), s);
    }
  }

  await db.query(
    `INSERT INTO seats (row_label, seat_number) VALUES ${values.join(', ')}`,
    params
  );
}

export function getDb() {
  if (!db) throw new Error('Database not initialised. Call initDb() first.');
  return db;
}

// For tests: reset all seats to available and clear holds/bookings.
export async function resetSeats() {
  const d = getDb();
  await d.query(
    `UPDATE seats SET status='available', hold_id=NULL, hold_expires_at=NULL, booked_by=NULL`
  );
  await d.query('DELETE FROM holds');
  await d.query('DELETE FROM bookings');
}
