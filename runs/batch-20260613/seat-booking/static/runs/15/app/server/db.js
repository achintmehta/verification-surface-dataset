import { PGlite } from '@electric-sql/pglite';
import { DB_DIR, ROW_LABELS, SEATS_PER_ROW } from './config.js';

// A single embedded PGLite instance, persisted to the local file system.
// PGLite runs a single Postgres engine in-process; we serialize all
// write operations that must be atomic behind explicit transactions.
let db = null;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_DIR);
  await db.waitReady;
  await initSchema(db);
  await seedSeats(db);
  return db;
}

async function initSchema(database) {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id              TEXT PRIMARY KEY,
      row_label       TEXT NOT NULL,
      seat_number     INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available','held','booked')),
      hold_id         TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by       TEXT,
      UNIQUE (row_label, seat_number)
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','confirmed','released','expired')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats (hold_id);
    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats (status);
  `);
}

async function seedSeats(database) {
  const { rows } = await database.query('SELECT COUNT(*)::int AS count FROM seats');
  if (rows[0].count > 0) return;

  // Build a single multi-row insert for the fixed seat map.
  const values = [];
  const params = [];
  let p = 1;
  for (const label of ROW_LABELS) {
    for (let n = 1; n <= SEATS_PER_ROW; n++) {
      const id = `${label}${n}`;
      values.push(`($${p++}, $${p++}, $${p++}, 'available')`);
      params.push(id, label, n);
    }
  }
  await database.query(
    `INSERT INTO seats (id, row_label, seat_number, status) VALUES ${values.join(', ')}`,
    params
  );
}
