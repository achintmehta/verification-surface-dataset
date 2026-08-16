import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { DB_DIR, ROWS, SEATS_PER_ROW } from './config.js';

let db = null;

/**
 * A simple async mutex. PGlite runs a single embedded Postgres instance and
 * does not support truly parallel transactions; serializing the critical
 * sections (hold acquisition / confirmation) guarantees that the
 * check-and-set on seats is atomic with respect to other writers.
 */
class Mutex {
  constructor() {
    this._queue = Promise.resolve();
  }

  runExclusive(fn) {
    const run = this._queue.then(() => fn());
    // Keep the chain alive even if fn rejects.
    this._queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

export const writeLock = new Mutex();

export async function getDb() {
  if (db) return db;

  // Ensure the data directory's parent exists. PGlite will create the dir.
  fs.mkdirSync(DB_DIR, { recursive: true });

  db = new PGlite(DB_DIR);
  await db.waitReady;
  await initSchema(db);
  return db;
}

async function initSchema(database) {
  await database.exec(`
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

  await seedSeats(database);
}

/**
 * Seed a fixed seat map of ROWS x SEATS_PER_ROW. Idempotent: only inserts
 * seats that do not already exist, so restarts preserve persisted state.
 */
async function seedSeats(database) {
  const res = await database.query('SELECT COUNT(*)::int AS count FROM seats');
  if (res.rows[0].count > 0) return;

  const rowLabels = [];
  for (let r = 0; r < ROWS; r++) {
    // A, B, C, ... (supports more than 26 rows with AA, AB, ... if ever needed)
    rowLabels.push(rowLabelForIndex(r));
  }

  const values = [];
  const params = [];
  let p = 1;
  for (let r = 0; r < ROWS; r++) {
    const label = rowLabels[r];
    for (let s = 1; s <= SEATS_PER_ROW; s++) {
      const id = `${label}${s}`;
      values.push(`($${p++}, $${p++}, $${p++})`);
      params.push(id, label, s);
    }
  }

  await database.query(
    `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')}`,
    params
  );
}

function rowLabelForIndex(index) {
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}
