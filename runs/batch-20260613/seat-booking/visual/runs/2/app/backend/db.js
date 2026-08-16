import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'pglite');

let db;

export async function getDb() {
  if (!db) {
    db = new PGlite(DB_PATH);
    await db.waitReady;
  }
  return db;
}

export async function initDb() {
  const db = await getDb();

  // Create seats table
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
  `);

  // Seed seat map: 5 rows × 10 seats
  const rows = ['A', 'B', 'C', 'D', 'E'];
  const seatsPerRow = 10;

  for (const row of rows) {
    for (let seatNum = 1; seatNum <= seatsPerRow; seatNum++) {
      const id = `${row}${seatNum}`;
      await db.query(
        `INSERT INTO seats (id, row_label, seat_number, status)
         VALUES ($1, $2, $3, 'available')
         ON CONFLICT (id) DO NOTHING`,
        [id, row, seatNum]
      );
    }
  }

  console.log('Database initialized and seeded.');
  return db;
}
