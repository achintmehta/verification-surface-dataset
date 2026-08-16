import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'pgdata');

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  await db.waitReady;
  return db;
}

export async function initDb() {
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
      seat_ids INTEGER[] NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'released', 'expired'))
    );
  `);

  // Seed seats if empty
  const { rows } = await pg.query('SELECT COUNT(*) as count FROM seats');
  const count = parseInt(rows[0].count, 10);

  if (count === 0) {
    const rowLabels = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const rowLabel of rowLabels) {
      for (let seatNum = 1; seatNum <= seatsPerRow; seatNum++) {
        values.push(`($${paramIdx}, $${paramIdx + 1})`);
        params.push(rowLabel, seatNum);
        paramIdx += 2;
      }
    }

    await pg.query(
      `INSERT INTO seats (row_label, seat_number) VALUES ${values.join(', ')}`,
      params
    );
    console.log(`Seeded ${rowLabels.length * seatsPerRow} seats`);
  }

  return pg;
}
