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

  // Create enum type if it doesn't exist (PGLite may not support IF NOT EXISTS for types)
  await pg.exec(`
    DO $$ BEGIN
      CREATE TYPE seat_status AS ENUM ('available', 'held', 'booked');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `);

  // Create seats table
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status seat_status NOT NULL DEFAULT 'available',
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      session_id TEXT,
      booked_by TEXT,
      UNIQUE(row_label, seat_number)
    );
  `);

  // Create holds table to track hold metadata
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_ids INTEGER[] NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed the seat map if empty
  const countResult = await pg.query('SELECT COUNT(*) as cnt FROM seats');
  const count = parseInt(countResult.rows[0].cnt, 10);

  if (count === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    const values = [];
    const params = [];
    let paramIndex = 1;

    for (const rowLabel of rows) {
      for (let seatNum = 1; seatNum <= seatsPerRow; seatNum++) {
        values.push(`($${paramIndex}, $${paramIndex + 1})`);
        params.push(rowLabel, seatNum);
        paramIndex += 2;
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
