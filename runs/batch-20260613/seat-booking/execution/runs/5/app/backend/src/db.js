/**
 * Database module: initializes PGLite, creates schema, seeds seat map.
 */
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data/pglite');

// Hold TTL in seconds
export const HOLD_TTL_SECONDS = 60;

// Seat map configuration
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

let db;

export async function initDb() {
  db = new PGlite(DATA_DIR);

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

    CREATE TABLE IF NOT EXISTS holds (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at    TIMESTAMPTZ NOT NULL,
      confirmed     BOOLEAN NOT NULL DEFAULT FALSE,
      released      BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);
    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);
    CREATE INDEX IF NOT EXISTS idx_holds_expires_at ON holds(expires_at);
  `);

  // Seed seats if the table is empty
  const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM seats');
  const count = parseInt(rows[0].cnt, 10);

  if (count === 0) {
    const insertValues = [];
    for (const row of ROWS) {
      for (let s = 1; s <= SEATS_PER_ROW; s++) {
        const id = `${row}${s}`;
        insertValues.push(`('${id}', '${row}', ${s}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(
      `INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by)
       VALUES ${insertValues.join(',\n')};`
    );
    console.log(`Seeded ${ROWS.length * SEATS_PER_ROW} seats.`);
  } else {
    console.log(`Database already has ${count} seats.`);
  }

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}
