import { PGlite } from '@electric-sql/pglite';
import { DB_DIR, ROW_LABELS, SEATS_PER_ROW } from './config.js';

// Singleton PGLite instance, persisted to local disk.
let db = null;

// PGLite executes statements serially on a single connection, which gives
// us a natural serialization point. We additionally wrap multi-statement
// critical sections in explicit transactions and use a process-local async
// mutex (see locks.js) to ensure check-and-set sequences are atomic with
// respect to one another.
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
      -- 'active'   : hold is live and may be confirmed
      -- 'confirmed': hold was confirmed; its seats are booked
      -- 'released' : hold released early or expired
      status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'confirmed', 'released'))
    );

    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);
    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);
  `);
}

// Seed the fixed seat map exactly once.
async function seedSeats(database) {
  const { rows } = await database.query('SELECT COUNT(*)::int AS count FROM seats');
  if (rows[0].count > 0) return;

  const values = [];
  const params = [];
  let p = 1;
  for (const rowLabel of ROW_LABELS) {
    for (let n = 1; n <= SEATS_PER_ROW; n++) {
      const id = `${rowLabel}${n}`;
      values.push(`($${p++}, $${p++}, $${p++})`);
      params.push(id, rowLabel, n);
    }
  }
  await database.query(
    `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')}`,
    params
  );
}
