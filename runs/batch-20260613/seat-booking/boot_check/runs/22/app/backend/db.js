import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db = null;

const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

export async function initDb() {
  const dataDir = path.join(__dirname, '..', 'pgdata');
  db = new PGlite(dataDir);

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT,
      UNIQUE(row_label, seat_number)
    );

    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_ids INTEGER[] NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'released', 'expired'))
    );
  `);

  // Seed seats if table is empty
  const countResult = await db.query('SELECT COUNT(*) as cnt FROM seats');
  const count = parseInt(countResult.rows[0].cnt, 10);

  if (count === 0) {
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const row of ROWS) {
      for (let seatNum = 1; seatNum <= SEATS_PER_ROW; seatNum++) {
        values.push(`($${paramIdx}, $${paramIdx + 1})`);
        params.push(row, seatNum);
        paramIdx += 2;
      }
    }

    await db.query(
      `INSERT INTO seats (row_label, seat_number) VALUES ${values.join(', ')}`,
      params
    );
    console.log(`Seeded ${ROWS.length * SEATS_PER_ROW} seats`);
  }

  console.log('Database initialized');
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}
