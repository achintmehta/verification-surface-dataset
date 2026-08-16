import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, '..', 'data', 'pgdata');

// Ensure parent dir exists
fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });

export const ROWS = 5;
export const SEATS_PER_ROW = 10;
export const TOTAL_SEATS = ROWS * SEATS_PER_ROW;

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  await initSchema(db);
  return db;
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT
    );

    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
  `);

  // Seed seats if empty
  const res = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  const count = res.rows[0].count;
  if (count === 0) {
    const rowLabels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let r = 0; r < ROWS; r++) {
      const label = rowLabels[r];
      for (let s = 1; s <= SEATS_PER_ROW; s++) {
        const id = `${label}${s}`;
        await db.query(
          'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)',
          [id, label, s, 'available']
        );
      }
    }
  }
}
