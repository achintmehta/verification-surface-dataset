import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration of the fixed seat map.
export const ROWS = ['A', 'B', 'C', 'D', 'E'];
export const SEATS_PER_ROW = 10;
export const TOTAL_SEATS = ROWS.length * SEATS_PER_ROW;

// Hold time-to-live in milliseconds.
export const HOLD_TTL_MS = 60 * 1000;

const DATA_DIR = path.join(__dirname, '..', 'data');

let db;

/**
 * Initialize the embedded PGLite database (persisted to local disk),
 * create the schema, and seed the fixed seat map if needed.
 */
export async function initDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new PGlite(path.join(DATA_DIR, 'pgdata'));
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id            INTEGER PRIMARY KEY,
      row_label     TEXT    NOT NULL,
      seat_number   INTEGER NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'available'
                            CHECK (status IN ('available','held','booked')),
      hold_id       TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by     TEXT,
      UNIQUE (row_label, seat_number)
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','confirmed','released','expired'))
    );

    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats (hold_id);
    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats (status);
  `);

  // Seed the fixed seat map (idempotent).
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (rows[0].count === 0) {
    let id = 1;
    const values = [];
    const params = [];
    let p = 1;
    for (const row of ROWS) {
      for (let n = 1; n <= SEATS_PER_ROW; n++) {
        values.push(`($${p++}, $${p++}, $${p++})`);
        params.push(id, row, n);
        id++;
      }
    }
    await db.query(
      `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(',')}`,
      params
    );
  }

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}
