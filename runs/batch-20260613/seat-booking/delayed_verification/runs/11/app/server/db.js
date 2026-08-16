import { PGlite } from '@electric-sql/pglite';
import { DATA_DIR, ROWS, SEATS_PER_ROW, rowLabel } from './config.js';

let db = null;

/**
 * Initialize the embedded PGLite database, create schema, and seed the
 * fixed seat map if it has not been seeded yet.
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
      booked_by       TEXT
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      -- 'active'   : hold is live, seats are held
      -- 'confirmed': hold was confirmed, seats are booked
      -- 'released' : hold released early or expired
      status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'confirmed', 'released'))
    );

    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats (hold_id);
    CREATE INDEX IF NOT EXISTS idx_holds_status ON holds (status);
  `);

  await seedSeats();
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

/**
 * Seed the fixed seat map only once. Idempotent across restarts.
 */
async function seedSeats() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (rows[0].count > 0) return;

  const values = [];
  const params = [];
  let p = 1;
  for (let r = 0; r < ROWS; r++) {
    const label = rowLabel(r);
    for (let s = 1; s <= SEATS_PER_ROW; s++) {
      const id = `${label}${s}`;
      values.push(`($${p++}, $${p++}, $${p++})`);
      params.push(id, label, s);
    }
  }

  await db.query(
    `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')}`,
    params
  );
}
