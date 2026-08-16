import { PGlite } from '@electric-sql/pglite';
import { ROWS, SEATS_PER_ROW, DATA_DIR } from './config.js';

let db = null;

/**
 * Initialize the embedded PGLite database (persisting to local disk),
 * create the schema and seed the fixed seat map if necessary.
 */
export async function initDb() {
  if (db) return db;

  db = new PGlite(DATA_DIR);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id          INTEGER PRIMARY KEY,
      row_label   TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'available'
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
  `);

  // Seed the fixed seat map only if the table is empty.
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (rows[0].count === 0) {
    await seedSeats();
  }

  return db;
}

async function seedSeats() {
  let id = 1;
  const values = [];
  const params = [];
  let p = 1;
  for (const row of ROWS) {
    for (let n = 1; n <= SEATS_PER_ROW; n++) {
      values.push(`($${p++}, $${p++}, $${p++}, 'available')`);
      params.push(id, row, n);
      id++;
    }
  }
  await db.query(
    `INSERT INTO seats (id, row_label, seat_number, status) VALUES ${values.join(', ')}`,
    params
  );
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}
