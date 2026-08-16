/**
 * Database module: initialises PGLite, creates schema, seeds seat map.
 *
 * We export a single `db` promise that resolves to the ready PGLite instance
 * so every other module can `await db` and get the same singleton.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Allow tests to inject an in-memory database by setting this env var.
const DATA_DIR = process.env.PGLITE_DATA_DIR
  ? process.env.PGLITE_DATA_DIR
  : path.join(__dirname, '../../data/pglite');

// Hold TTL in seconds (configurable for tests).
// Read dynamically so tests can change process.env.HOLD_TTL_SECONDS.
export function getHoldTtlSeconds() {
  return process.env.HOLD_TTL_SECONDS
    ? parseInt(process.env.HOLD_TTL_SECONDS, 10)
    : 60;
}

// Keep the named export for backward compat; routes should use getHoldTtlSeconds().
export const HOLD_TTL_SECONDS = 60;

// Seat map dimensions.
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

let _db = null;

export async function getDb() {
  if (_db) return _db;

  const dataDir = process.env.PGLITE_DATA_DIR || DATA_DIR;

  if (dataDir === ':memory:') {
    _db = new PGlite();
  } else {
    _db = new PGlite(dataDir);
  }

  await _db.waitReady;
  await initSchema(_db);
  return _db;
}

async function initSchema(db) {
  // Create seats table.
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
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL,
      confirmed   BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);

  // Seed seat map only if empty.
  const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM seats');
  const count = parseInt(rows[0].cnt, 10);
  if (count === 0) {
    const values = [];
    const params = [];
    let p = 1;
    for (const row of ROWS) {
      for (let s = 1; s <= SEATS_PER_ROW; s++) {
        const id = `${row}${s}`;
        values.push(`($${p++}, $${p++}, $${p++})`);
        params.push(id, row, s);
      }
    }
    await db.query(
      `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')}`,
      params
    );
  }
}

// Reset the singleton (used in tests).
export function resetDb() {
  _db = null;
}
