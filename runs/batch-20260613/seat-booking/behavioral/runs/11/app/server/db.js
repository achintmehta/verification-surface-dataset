import { PGlite } from '@electric-sql/pglite';
import { ROWS, SEATS_PER_ROW } from './config.js';

/**
 * Create (or open) a PGLite database, initialize the schema, and seed the
 * fixed seat map. Idempotent: re-running it does not duplicate seats.
 *
 * @param {string} dataDir - directory PGLite persists to. Use 'memory://' for tests.
 * @returns {Promise<PGlite>}
 */
export async function createDb(dataDir) {
  const db = new PGlite(dataDir);
  await db.waitReady;
  await initSchema(db);
  await seedSeats(db);
  return db;
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id            TEXT PRIMARY KEY,
      row_label     TEXT NOT NULL,
      seat_number   INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'available'
                      CHECK (status IN ('available', 'held', 'booked')),
      hold_id       TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by     TEXT,
      UNIQUE (row_label, seat_number)
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'confirmed', 'released'))
    );

    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats (status);
    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats (hold_id);
  `);
}

async function seedSeats(db) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats;');
  if (rows[0].count > 0) {
    return; // already seeded
  }

  const values = [];
  const params = [];
  let i = 1;
  for (const row of ROWS) {
    for (let n = 1; n <= SEATS_PER_ROW; n++) {
      const id = `${row}${n}`;
      values.push(`($${i++}, $${i++}, $${i++})`);
      params.push(id, row, n);
    }
  }

  await db.query(
    `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')};`,
    params,
  );
}
