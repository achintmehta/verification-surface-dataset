import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pglite');

// Ensure the data directory exists before PGLite tries to use it
fs.mkdirSync(DATA_DIR, { recursive: true });

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  return db;
}

// Hold TTL in seconds
export const HOLD_TTL_SECONDS = 60;

// Seat map configuration
export const ROWS = ['A', 'B', 'C', 'D', 'E'];
export const SEATS_PER_ROW = 10;

export async function initDb() {
  const db = await getDb();

  // Create seats table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id          TEXT PRIMARY KEY,
      row_label   TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available', 'held', 'booked')),
      hold_id     TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by   TEXT,
      UNIQUE (row_label, seat_number)
    );
  `);

  // Create holds table for idempotent confirmation tracking
  await db.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed seats if empty
  const { rows } = await db.query(`SELECT COUNT(*) AS cnt FROM seats`);
  const count = parseInt(rows[0].cnt, 10);

  if (count === 0) {
    console.log('[db] Seeding seat map...');
    const values = [];
    for (const row of ROWS) {
      for (let s = 1; s <= SEATS_PER_ROW; s++) {
        const id = `${row}${s}`;
        values.push(`('${id}', '${row}', ${s}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(`
      INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by)
      VALUES ${values.join(',\n')};
    `);
    console.log(`[db] Seeded ${ROWS.length * SEATS_PER_ROW} seats.`);
  } else {
    console.log(`[db] Found ${count} existing seats.`);
  }

  return db;
}
