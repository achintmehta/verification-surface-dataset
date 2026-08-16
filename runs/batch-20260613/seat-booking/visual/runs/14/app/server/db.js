import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration of the fixed seat map.
export const ROWS = ['A', 'B', 'C', 'D', 'E'];
export const SEATS_PER_ROW = 10;

let db;

/**
 * Open (or create) the embedded PGLite database on local disk and ensure the
 * schema + fixed seat map are present.
 */
export async function initDb() {
  const dataDir = path.join(__dirname, '..', 'pgdata');
  db = new PGlite(dataDir);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id              TEXT PRIMARY KEY,
      row_label       TEXT NOT NULL,
      seat_number     INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'available'
                      CHECK (status IN ('available', 'held', 'booked')),
      hold_id         TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by       TEXT
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      confirmed   BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);

  // Seed the fixed seat map exactly once.
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (rows[0].count === 0) {
    await db.transaction(async (tx) => {
      for (const row of ROWS) {
        for (let n = 1; n <= SEATS_PER_ROW; n++) {
          const id = `${row}${n}`;
          await tx.query(
            'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)',
            [id, row, n, 'available']
          );
        }
      }
    });
  }

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}
