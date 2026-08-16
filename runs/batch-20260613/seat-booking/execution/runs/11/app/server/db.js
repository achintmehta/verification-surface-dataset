import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Seat map configuration
export const ROWS = ['A', 'B', 'C', 'D', 'E'];
export const SEATS_PER_ROW = 10;
export const TOTAL_SEATS = ROWS.length * SEATS_PER_ROW;

// Hold time-to-live in milliseconds
export const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 60_000);

const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, '..', '.pgdata');

let dbInstance = null;
// A simple promise-chain mutex to serialize write transactions on the
// single embedded PGLite connection. PGLite runs in-process and does not
// support truly concurrent connections, so we serialize the critical
// sections to guarantee atomic check-and-set semantics for holds/confirms.
let writeQueue = Promise.resolve();

/**
 * Run a function exclusively with respect to other queued writers.
 * This is the concurrency-control primitive that makes seat acquisition
 * atomic: only one hold/confirm/release runs at a time.
 */
export function runExclusive(fn) {
  const result = writeQueue.then(() => fn());
  // Keep the queue alive even if fn rejects.
  writeQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export async function getDb() {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  dbInstance = await PGlite.create(DATA_DIR);
  await initSchema(dbInstance);
  return dbInstance;
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'held', 'booked')),
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
        CHECK (status IN ('active', 'confirmed', 'released', 'expired'))
    );

    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);
    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);
  `);

  // Seed the fixed seat map exactly once.
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (rows[0].count === 0) {
    const values = [];
    const params = [];
    let i = 1;
    for (const row of ROWS) {
      for (let n = 1; n <= SEATS_PER_ROW; n++) {
        const id = `${row}${n}`;
        values.push(`($${i++}, $${i++}, $${i++})`);
        params.push(id, row, n);
      }
    }
    await db.query(
      `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')}`,
      params
    );
  }
}
