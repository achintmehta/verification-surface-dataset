import { PGlite } from '@electric-sql/pglite';
import { DATA_DIR, ROW_LABELS, SEATS_PER_ROW } from './config.js';

let db = null;

/**
 * Initialize the embedded PGLite database, create the schema, and seed the
 * fixed seat map if it has not been seeded yet. Returns the singleton db.
 */
export async function initDb() {
  if (db) return db;

  db = new PGlite(DATA_DIR);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id              TEXT PRIMARY KEY,
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

    -- A hold groups the seats acquired together in one request.
    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'confirmed', 'released', 'expired'))
    );
  `);

  await seedSeats();
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

async function seedSeats() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (rows[0].count > 0) return;

  const values = [];
  const params = [];
  let p = 1;
  for (const rowLabel of ROW_LABELS) {
    for (let seatNumber = 1; seatNumber <= SEATS_PER_ROW; seatNumber += 1) {
      const id = `${rowLabel}${seatNumber}`;
      values.push(`($${p}, $${p + 1}, $${p + 2})`);
      params.push(id, rowLabel, seatNumber);
      p += 3;
    }
  }

  await db.query(
    `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')}`,
    params,
  );
}
