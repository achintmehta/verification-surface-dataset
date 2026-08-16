import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.PGLITE_DIR
  ? path.resolve(process.env.PGLITE_DIR)
  : path.join(__dirname, '..', 'data', 'pgdata');

// Seat map configuration
export const ROWS = 5;
export const SEATS_PER_ROW = 10;
export const ROW_LABELS = ['A', 'B', 'C', 'D', 'E'];

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;

  fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });

  const db = new PGlite(DATA_DIR);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available'
        CHECK (status IN ('available','held','booked')),
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
        CHECK (status IN ('active','confirmed','released','expired'))
    );
  `);

  // Seed the fixed seat map (idempotent)
  const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM seats;');
  if (rows[0].c === 0) {
    const values = [];
    const params = [];
    let i = 1;
    for (let r = 0; r < ROWS; r++) {
      const label = ROW_LABELS[r] || String.fromCharCode(65 + r);
      for (let s = 1; s <= SEATS_PER_ROW; s++) {
        const id = `${label}${s}`;
        values.push(`($${i++}, $${i++}, $${i++}, 'available')`);
        params.push(id, label, s);
      }
    }
    await db.query(
      `INSERT INTO seats (id, row_label, seat_number, status) VALUES ${values.join(',')};`,
      params
    );
  }

  dbInstance = db;
  return db;
}
