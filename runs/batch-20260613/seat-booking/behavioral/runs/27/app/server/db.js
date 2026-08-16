import { PGlite } from '@electric-sql/pglite';

let db = null;
const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes TTL

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
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT
    );
  `);
  
  // Check if seats are seeded
  const countRes = await db.query('SELECT COUNT(*) as count FROM seats');
  const count = countRes.rows[0].count;
  
  if (count === 0) {
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
  console.log('Seeded 50 seats');
}

export async function getDb() {
  if (!db) await initDb();
  return db;
}

// Helper to release expired holds
export async function releaseExpiredHolds() {
  const database = await getDb();
  const now = new Date().toISOString();
  
  const result = await database.query(`
    UPDATE seats 
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL
    WHERE status = 'held' AND hold_expires_at < $1
    RETURNING id, row_label, seat_number
  `, [now]);
  
  return result.rows;
}

export { HOLD_TTL_MS };