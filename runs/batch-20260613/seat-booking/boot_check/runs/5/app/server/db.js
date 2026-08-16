import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pglite');

// Ensure the data directory exists before PGLite tries to use it
fs.mkdirSync(DATA_DIR, { recursive: true });

let db;

export async function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export async function initDb() {
  db = new PGlite(DATA_DIR);
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
    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);
    CREATE INDEX IF NOT EXISTS idx_holds_expires_at ON holds(expires_at);
  `);
}

async function seedSeats() {
  const rows = ['A', 'B', 'C', 'D', 'E'];
  const seatsPerRow = 10;

  // Only seed if table is empty
  const result = await db.query('SELECT COUNT(*) as count FROM seats');
  const count = parseInt(result.rows[0].count, 10);
  if (count > 0) return;

  const values = [];
  const params = [];
  let paramIdx = 1;

  for (const row of rows) {
    for (let seat = 1; seat <= seatsPerRow; seat++) {
      const id = `${row}${seat}`;
      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(id, row, seat);
    }
  }

  await db.query(
    `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')}`,
    params
  );

  console.log(`Seeded ${rows.length * seatsPerRow} seats.`);
}
