const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

let db;

async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  await db.waitReady;
  return db;
}

async function initDb() {
  const pg = await getDb();

  // Create seats table
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT,
      session_id TEXT,
      UNIQUE(row_label, seat_number)
    );
  `);

  // Create holds table to track hold metadata
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'released', 'expired'))
    );
  `);

  // Seed the seat map if empty (5 rows A-E, 10 seats each)
  const countResult = await pg.query('SELECT COUNT(*) as cnt FROM seats');
  const count = parseInt(countResult.rows[0].cnt, 10);

  if (count === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const row of rows) {
      for (let s = 1; s <= seatsPerRow; s++) {
        values.push(`($${paramIdx}, $${paramIdx + 1})`);
        params.push(row, s);
        paramIdx += 2;
      }
    }

    await pg.query(
      `INSERT INTO seats (row_label, seat_number) VALUES ${values.join(', ')}`,
      params
    );
    console.log(`Seeded ${rows.length * seatsPerRow} seats`);
  }

  return pg;
}

module.exports = { getDb, initDb };
