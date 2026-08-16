import { PGlite } from '@electric-sql/pglite';

let db = null;
const TTL_MS = 2 * 60 * 1000; // 2 minutes TTL

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
  
  // Seed if empty
  const count = await db.query('SELECT COUNT(*) as count FROM seats');
  if (parseInt(count.rows[0].count) === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const values = [];
    for (let r = 0; r < 5; r++) {
      for (let s = 1; s <= 10; s++) {
        const id = `${rows[r]}${s}`;
        values.push(`('${id}', '${rows[r]}', ${s}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(`INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by) VALUES ${values.join(',')}`);
  }
  
  return db;
}

export async function releaseExpiredHolds() {
  const database = await initDb();
  const now = new Date().toISOString();
  const result = await database.query(`
    UPDATE seats 
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
    WHERE status = 'held' AND hold_expires_at < $1
    RETURNING id
  `, [now]);
  return result.rows.map(r => r.id);
}

export async function getAllSeats() {
  const database = await initDb();
  await releaseExpiredHolds();
  const result = await database.query(`
    SELECT id, row_label, seat_number, 
           CASE 
             WHEN status = 'held' AND hold_expires_at > NOW() THEN 'held'
             WHEN status = 'held' THEN 'available'
             ELSE status 
           END as status,
           hold_id, hold_expires_at, booked_by
    FROM seats 
    ORDER BY row_label, seat_number
  `);
  return result.rows;
}

export async function createHold(seatIds, sessionId) {
  const database = await initDb();
  await releaseExpiredHolds();
  
  return await database.transaction(async (tx) => {
    // Check all seats are available
    const placeholders = seatIds.map((_, i) => `$${i + 1}`).join(',');
    const check = await tx.query(
      `SELECT id FROM seats WHERE id IN (${placeholders}) AND status != 'available'`,
      seatIds
    );
    
    if (check.rows.length > 0) {
      const conflicting = check.rows.map(r => r.id);
      return { success: false, conflictingSeats: conflicting };
    }
    
    // Create hold
    const holdId = 'hold_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
    
    for (const seatId of seatIds) {
      await tx.query(
        `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id = $3`,
        [holdId, expiresAt, seatId]
      );
    }
    
    return { 
      success: true, 
      holdId, 
      seatIds, 
      expiresAt,
      ttlSeconds: Math.floor(TTL_MS / 1000)
    };
  });
}

export async function confirmHold(holdId, sessionId) {
  const database = await initDb();
  await releaseExpiredHolds();
  
  return await database.transaction(async (tx) => {
    // Check hold exists and not expired
    const holdCheck = await tx.query(
      `SELECT id FROM seats WHERE hold_id = $1 AND status = 'held' AND hold_expires_at > NOW() LIMIT 1`,
      [holdId]
    );
    
    if (holdCheck.rows.length === 0) {
      // Check if already booked (idempotency)
      const bookedCheck = await tx.query(
        `SELECT id FROM seats WHERE hold_id = $1 AND status = 'booked' LIMIT 1`,
        [holdId]
      );
      if (bookedCheck.rows.length > 0) {
        return { success: true, alreadyBooked: true };
      }
      return { success: false, error: 'Hold not found or expired' };
    }
    
    // Book them
    const bookedResult = await tx.query(
      `UPDATE seats SET status = 'booked', booked_by = $1, hold_expires_at = NULL WHERE hold_id = $2 RETURNING id`,
      [sessionId, holdId]
    );
    
    const bookedSeatIds = bookedResult.rows.map(r => r.id);
    return { success: true, bookedSeatIds };
  });
}

export async function releaseHold(holdId) {
  const database = await initDb();
  await releaseExpiredHolds();
  
  const result = await database.query(
    `UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL WHERE hold_id = $1 RETURNING id`,
    [holdId]
  );
  
  return result.rows.map(r => r.id);
}

export function getDb() {
  return db;
}