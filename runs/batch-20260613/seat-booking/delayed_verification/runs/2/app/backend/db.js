/**
 * db.js – PGLite initialisation, schema creation, and seed.
 *
 * We use PGLite in "filesystem" mode so data survives server restarts.
 * All SQL is raw; no ORM.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pglite');

// ── singleton ──────────────────────────────────────────────────────────────
let _db = null;

export async function getDb() {
  if (_db) return _db;
  // Ensure the data directory exists before PGLite tries to use it.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new PGlite(DATA_DIR);
  await _db.waitReady;
  await initSchema(_db);
  return _db;
}

// ── schema + seed ──────────────────────────────────────────────────────────
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 10;

async function initSchema(db) {
  // Create tables inside a transaction so the seed is atomic.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id               TEXT        PRIMARY KEY,
      row_label        TEXT        NOT NULL,
      seat_number      INTEGER     NOT NULL,
      status           TEXT        NOT NULL DEFAULT 'available'
                                   CHECK (status IN ('available','held','booked')),
      hold_id          TEXT,
      hold_expires_at  TIMESTAMPTZ,
      booked_by        TEXT,
      UNIQUE (row_label, seat_number)
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT        PRIMARY KEY,
      session_id  TEXT        NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      confirmed   BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_seats_hold_id
      ON seats (hold_id);

    CREATE INDEX IF NOT EXISTS idx_seats_status
      ON seats (status);

    CREATE INDEX IF NOT EXISTS idx_holds_expires_at
      ON holds (expires_at);
  `);

  // Seed only when the table is empty.
  const { rows } = await db.query(`SELECT COUNT(*) AS cnt FROM seats`);
  if (parseInt(rows[0].cnt, 10) === 0) {
    const values = [];
    for (const row of ROWS) {
      for (let s = 1; s <= SEATS_PER_ROW; s++) {
        const id = `${row}${s}`;
        values.push(`('${id}', '${row}', ${s}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(
      `INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by)
       VALUES ${values.join(',\n')};`
    );
    console.log(`[db] Seeded ${ROWS.length * SEATS_PER_ROW} seats.`);
  }
}
