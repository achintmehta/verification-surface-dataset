const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const db = new PGlite(path.join(__dirname, 'pglite-data'));

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      hold_id TEXT,
      hold_expires_at BIGINT,
      booked_by TEXT
    );
  `);

  const res = await db.query(`SELECT count(*) as count FROM seats`);
  if (res.rows[0].count == 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    for (let r of rows) {
      for (let s = 1; s <= seatsPerRow; s++) {
        const id = `${r}${s}`;
        await db.query(
          `INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)`,
          [id, r, s, 'available']
        );
      }
    }
  }
}

module.exports = { db, initDb };
