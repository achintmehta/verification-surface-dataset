import { PGlite } from '@electric-sql/pglite';

let db = null;
const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes

export async function initDb() {
  if (db) return db;

  db = new PGlite('./seat-booking-data');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at TIMESTAMP,
      booked_by TEXT,
      UNIQUE(row_label, seat_number)
    );
  `);

  // Check if seats are seeded
  const result = await db.query('SELECT COUNT(*) as count FROM seats');
  if (result.rows[0].count === 0) {
    await seedSeats();
  }

  return db;
}

async function seedSeats() {
  const rows = ['A', 'B', 'C', 'D', 'E'];
  const seatsPerRow = 10;
  const values = [];

  for (const row of rows) {
    for (let num = 1; num <= seatsPerRow; num++) {
      const id = `${row}${num}`;
      values.push(`('${id}', '${row}', ${num}, 'available', NULL, NULL, NULL)`);
    }
  }

  await db.exec(`
    INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by)
    VALUES ${values.join(', ')}
  `);
}

export async function getDb() {
  if (!db) await initDb();
  return db;
}

export function getHoldTTL() {
  return HOLD_TTL_MS;
}