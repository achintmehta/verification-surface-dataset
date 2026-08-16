import { PGlite } from '@electric-sql/pglite';

const DB_PATH = 'file://./seat_booking.db';

let db = null;

export async function getDb() {
  if (!db) {
    db = new PGlite(DB_PATH);
    await db.waitReady;
    await initializeSchema(db);
  }
  return db;
}

async function initializeSchema(db) {
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

  // Check if seats are already seeded
  const result = await db.query('SELECT COUNT(*) as count FROM seats');
  const count = result.rows[0].count;
  
  if (count === 0) {
    // Seed 5 rows x 10 seats
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const values = [];
    const params = [];
    let paramIndex = 1;
    
    for (const row of rows) {
      for (let seatNum = 1; seatNum <= 10; seatNum++) {
        const id = `${row}${seatNum}`;
        values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        params.push(id, row, seatNum);
      }
    }
    
    await db.query(
      `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')}`,
      params
    );
  }
}

export async function releaseExpiredHolds(db) {
  const now = new Date().toISOString();
  const result = await db.query(`
    UPDATE seats 
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
    WHERE status = 'held' AND hold_expires_at < $1
    RETURNING id
  `, [now]);
  
  return result.rows.map(r => r.id);
}
