import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'pglite');

// Ensure the data directory exists before PGlite tries to use it
fs.mkdirSync(DB_PATH, { recursive: true });

// Hold TTL in seconds (use env var for testing)
export const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS || '60', 10);

let db;

export async function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export async function initDb() {
  db = new PGlite(DB_PATH);
  await db.waitReady;

  // Create seats table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id            TEXT PRIMARY KEY,
      row_label     TEXT NOT NULL,
      seat_number   INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'available'
                      CHECK (status IN ('available', 'held', 'booked')),
      hold_id       TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by     TEXT,
      UNIQUE (row_label, seat_number)
    );
  `);

  // Create holds table for idempotent confirmation tracking
  await db.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      expires_at  TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed seats if table is empty
  const result = await db.query('SELECT COUNT(*) as cnt FROM seats');
  const count = parseInt(result.rows[0].cnt, 10);

  if (count === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;

    const values = [];
    for (const row of rows) {
      for (let seat = 1; seat <= seatsPerRow; seat++) {
        const id = `${row}${seat}`;
        values.push(`('${id}', '${row}', ${seat}, 'available', NULL, NULL, NULL)`);
      }
    }

    await db.exec(`
      INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by)
      VALUES ${values.join(',\n')}
      ON CONFLICT DO NOTHING;
    `);

    console.log(`Seeded ${rows.length * seatsPerRow} seats.`);
  }

  console.log('Database initialized.');
  return db;
}
