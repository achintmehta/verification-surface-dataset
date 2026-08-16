import { PGlite } from '@electric-sql/pglite';

const db = new PGlite('./seat-booking.db');

export async function initDb() {
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

  // Seed 5 rows x 10 seats if empty
  const { rows } = await db.query('SELECT COUNT(*) as count FROM seats');
  if (parseInt(rows[0].count) === 0) {
    const values = [];
    for (let row = 1; row <= 5; row++) {
      const rowLabel = String.fromCharCode(64 + row); // A, B, C, D, E
      for (let seat = 1; seat <= 10; seat++) {
        const id = `${rowLabel}${seat}`;
        values.push(`('${id}', '${rowLabel}', ${seat}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(`INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by) VALUES ${values.join(', ')}`);
  }
}

export async function releaseExpiredHolds() {
  const now = new Date().toISOString();
  const result = await db.query(`
    UPDATE seats 
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL 
    WHERE status = 'held' AND hold_expires_at < $1
    RETURNING id
  `, [now]);
  return result.rows.map(r => r.id);
}

export { db };