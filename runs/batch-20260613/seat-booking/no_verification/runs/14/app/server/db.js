import { PGlite } from '@electric-sql/pglite';
import { config, rowLabels } from './config.js';

let db = null;

/**
 * Initialize the embedded PGLite database, create the schema if needed,
 * and seed the fixed seat map. Returns the PGlite instance.
 */
export async function initDb() {
  if (db) return db;

  db = new PGlite(config.dbDir);
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
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      status     TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
 * Seed the fixed seat map only if the seats table is empty.
 */
async function seedSeats() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats;');
  if (rows[0].count > 0) return;

  const labels = rowLabels(config.rows);
  const values = [];
  const params = [];
  let p = 1;
  for (const label of labels) {
    for (let n = 1; n <= config.seatsPerRow; n++) {
      const id = `${label}${n}`;
      values.push(`($${p++}, $${p++}, $${p++}, 'available')`);
      params.push(id, label, n);
    }
  }

  await db.query(
    `INSERT INTO seats (id, row_label, seat_number, status) VALUES ${values.join(', ')};`,
    params
  );
}
