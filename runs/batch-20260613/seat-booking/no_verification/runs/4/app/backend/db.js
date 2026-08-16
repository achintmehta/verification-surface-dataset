import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'pglite');

let db;

export async function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export async function initDb() {
  db = new PGlite(DB_PATH);
  await db.waitReady;
  await createSchema();
  await seedSeats();
  return db;
}

async function createSchema() {
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
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      expires_at    TIMESTAMPTZ NOT NULL,
      confirmed     BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);
    CREATE INDEX IF NOT EXISTS idx_seats_status  ON seats(status);
    CREATE INDEX IF NOT EXISTS idx_holds_expires ON holds(expires_at);
  `);
}

const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

async function seedSeats() {
  // Only seed if the table is empty
  const result = await db.query('SELECT COUNT(*) AS cnt FROM seats');
  const count = parseInt(result.rows[0].cnt, 10);
  if (count > 0) return;

  const values = [];
  const params = [];
  let idx = 1;

  for (const row of ROWS) {
    for (let s = 1; s <= SEATS_PER_ROW; s++) {
      const id = `${row}${s}`;
      values.push(`($${idx++}, $${idx++}, $${idx++})`);
      params.push(id, row, s);
    }
  }

  await db.query(
    `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')}`,
    params
  );

  console.log(`Seeded ${ROWS.length * SEATS_PER_ROW} seats.`);
}
