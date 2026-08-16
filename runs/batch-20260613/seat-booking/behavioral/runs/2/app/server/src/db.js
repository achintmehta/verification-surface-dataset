import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = process.env.DB_DIR || path.join(__dirname, '../../data/pglite');

// Singleton PGlite instance
let _db = null;

export async function getDb() {
  if (_db) return _db;
  // Ensure the data directory exists
  fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new PGlite(DB_DIR);
  await _db.waitReady;
  return _db;
}

// ─── Schema & Seed ────────────────────────────────────────────────────────────

const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;
export const HOLD_TTL_SECONDS = 30; // 30-second hold TTL

export async function initDb(db) {
  // Create seats table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id              TEXT PRIMARY KEY,
      row_label       TEXT NOT NULL,
      seat_number     INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available', 'held', 'booked')),
      hold_id         TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by       TEXT,
      UNIQUE (row_label, seat_number)
    )
  `);

  // Create holds table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Seed seats only if the table is empty
  const { rows } = await db.query(`SELECT COUNT(*) AS cnt FROM seats`);
  const count = parseInt(rows[0].cnt, 10);
  if (count === 0) {
    for (const row of ROWS) {
      for (let s = 1; s <= SEATS_PER_ROW; s++) {
        const id = `${row}${s}`;
        await db.query(
          `INSERT INTO seats (id, row_label, seat_number, status)
           VALUES ($1, $2, $3, 'available')
           ON CONFLICT DO NOTHING`,
          [id, row, s]
        );
      }
    }
  }
}
