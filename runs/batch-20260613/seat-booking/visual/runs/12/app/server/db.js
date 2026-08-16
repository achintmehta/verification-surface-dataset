import { PGlite } from '@electric-sql/pglite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { NUM_ROWS, SEATS_PER_ROW, DATA_DIR } from './config.js';

let db;

// Row labels A, B, C, ... for a reasonable number of rows.
function rowLabel(index) {
  // Supports more than 26 rows with AA, AB, ... but our default is 5.
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

export async function initDb() {
  // Ensure the parent directory exists; PGLite will create the data dir itself.
  try {
    mkdirSync(dirname(DATA_DIR), { recursive: true });
  } catch {
    /* ignore */
  }
  db = new PGlite(DATA_DIR);
  await db.waitReady;

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

    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats (hold_id);
    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats (status);
  `);

  await seedSeats();
  return db;
}

// Seed a fixed seat map only once (idempotent).
async function seedSeats() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats;');
  if (rows[0].count > 0) return;

  const values = [];
  const params = [];
  let p = 1;
  for (let r = 0; r < NUM_ROWS; r++) {
    const label = rowLabel(r);
    for (let s = 1; s <= SEATS_PER_ROW; s++) {
      const id = `${label}${s}`;
      values.push(`($${p++}, $${p++}, $${p++}, 'available')`);
      params.push(id, label, s);
    }
  }

  await db.query(
    `INSERT INTO seats (id, row_label, seat_number, status) VALUES ${values.join(', ')};`,
    params
  );
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}
