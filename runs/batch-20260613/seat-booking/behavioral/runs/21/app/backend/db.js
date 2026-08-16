import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db;

export async function getDb(dataDir) {
  if (db) return db;
  const dir = dataDir || path.join(__dirname, '..', 'pgdata');
  db = new PGlite(dir);
  await db.waitReady;
  return db;
}

export async function createFreshDb(dataDir) {
  const instance = new PGlite(dataDir);
  await instance.waitReady;
  return instance;
}

export async function initSchema(database) {
  await database.exec(`
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

  // Check if seats are already seeded
  const result = await database.query('SELECT COUNT(*)::int AS cnt FROM seats');
  if (result.rows[0].cnt === 0) {
    await seedSeats(database);
  }
}

async function seedSeats(database) {
  const rows = ['A', 'B', 'C', 'D', 'E'];
  const seatsPerRow = 10;

  const values = [];
  const params = [];
  let paramIdx = 1;

  for (const row of rows) {
    for (let seat = 1; seat <= seatsPerRow; seat++) {
      values.push(`($${paramIdx}, $${paramIdx + 1})`);
      params.push(row, seat);
      paramIdx += 2;
    }
  }

  await database.query(
    `INSERT INTO seats (row_label, seat_number) VALUES ${values.join(', ')}`,
    params
  );
}
