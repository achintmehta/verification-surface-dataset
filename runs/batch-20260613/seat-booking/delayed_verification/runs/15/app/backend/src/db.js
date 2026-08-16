import { PGlite } from '@electric-sql/pglite';
import { DATA_DIR, ROWS, SEATS_PER_ROW, rowLabel } from './config.js';

let db = null;

/**
 * Initialize the embedded PGLite database, create the schema, and seed the
 * fixed seat map if it has not yet been seeded.
 */
export async function initDb() {
  if (db) return db;

  db = new PGlite(DATA_DIR);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id              SERIAL PRIMARY KEY,
      row_label       TEXT    NOT NULL,
      seat_number     INTEGER NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'available'
                              CHECK (status IN ('available', 'held', 'booked')),
      hold_id         TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by       TEXT,
      UNIQUE (row_label, seat_number)
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      -- status: active | confirmed | released | expired
      status      TEXT NOT NULL DEFAULT 'active'
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

async function seedSeats() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (rows[0].count > 0) return;

  // Build a single multi-row insert for the fixed seat map.
  const values = [];
  const params = [];
  let p = 1;
  for (let r = 0; r < ROWS; r++) {
    const label = rowLabel(r);
    for (let s = 1; s <= SEATS_PER_ROW; s++) {
      values.push(`($${p++}, $${p++})`);
      params.push(label, s);
    }
  }

  await db.query(
    `INSERT INTO seats (row_label, seat_number) VALUES ${values.join(', ')}`,
    params,
  );
}
