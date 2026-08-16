const { PGlite } = require('@electric-sql/pglite');
const { v4: uuidv4 } = require('uuid');

async function run() {
  const db = new PGlite('./seat-booking-db-test');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      hold_id TEXT,
      hold_expires_at BIGINT,
      booked_by TEXT
    );
  `);

  await db.query(
    `INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, 'available')`,
    ['A1', 'A', 1]
  );

  const holdId = uuidv4();
  const expiresAt = Date.now() + 60000;
  
  await db.query('BEGIN');
  const checkRes = await db.query(
    `SELECT id, status FROM seats WHERE id IN ($1) FOR UPDATE`,
    ['A1']
  );
  console.log(checkRes.rows);
  
  await db.query(
    `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id IN ($3)`,
    [holdId, expiresAt, 'A1']
  );
  await db.query('COMMIT');

  const res = await db.query('SELECT * FROM seats');
  console.log(res.rows);
}

run().catch(console.error);
