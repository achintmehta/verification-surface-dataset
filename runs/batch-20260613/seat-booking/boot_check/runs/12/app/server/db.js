import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist PGLite data to local disk.
const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, '..', '.pgdata');
fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });

export const ROWS = 5;
export const SEATS_PER_ROW = 10;
export const TOTAL_SEATS = ROWS * SEATS_PER_ROW;

let db;

/**
 * Open (or create) the embedded PGLite database and initialize the schema +
 * seed data. Idempotent: safe to call once at startup.
 */
export async function initDb() {
  db = new PGlite(DATA_DIR);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id              TEXT PRIMARY KEY,
      row_label       TEXT NOT NULL,
      seat_number     INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available','held','booked')),
      hold_id         TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by       TEXT
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','confirmed','released','expired')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ
    );
  `);

  await seedSeats();
  return db;
}

async function seedSeats() {
  const res = await db.query('SELECT COUNT(*)::int AS c FROM seats');
  if (res.rows[0].c > 0) return;

  const rowLabels = [];
  for (let r = 0; r < ROWS; r++) {
    rowLabels.push(String.fromCharCode('A'.charCodeAt(0) + r));
  }

  await db.transaction(async (tx) => {
    for (const rowLabel of rowLabels) {
      for (let n = 1; n <= SEATS_PER_ROW; n++) {
        const id = `${rowLabel}${n}`;
        await tx.query(
          `INSERT INTO seats (id, row_label, seat_number, status)
           VALUES ($1, $2, $3, 'available')
           ON CONFLICT (id) DO NOTHING`,
          [id, rowLabel, n]
        );
      }
    }
  });
}

export function getDb() {
  if (!db) throw new Error('DB not initialized; call initDb() first');
  return db;
}
