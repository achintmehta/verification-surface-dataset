/**
 * db.js – PGLite initialisation, schema creation, and seed.
 *
 * We use PGLite in "file:" mode so data survives server restarts.
 * All SQL is plain PostgreSQL; PGLite supports the full Postgres dialect.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pglite');

// Ensure the data directory exists before PGLite tries to use it.
fs.mkdirSync(DATA_DIR, { recursive: true });

// ── singleton ──────────────────────────────────────────────────────────────
let _db = null;

export async function getDb() {
  if (_db) return _db;
  _db = new PGlite(`file://${DATA_DIR}`);
  await _db.waitReady;
  await initSchema(_db);
  return _db;
}

// ── schema + seed ──────────────────────────────────────────────────────────
const ROWS  = ['A', 'B', 'C', 'D', 'E'];
const SEATS = 10; // seats per row

async function initSchema(db) {
  // Wrap everything in a single transaction so the schema + seed are atomic.
  await db.transaction(async (tx) => {
    // ── seats table ──────────────────────────────────────────────────────
    await tx.exec(`
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
    `);

    // ── holds table ──────────────────────────────────────────────────────
    // Tracks each hold independently so we can do idempotent confirmation.
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS holds (
        id          TEXT        PRIMARY KEY,
        session_id  TEXT        NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        confirmed   BOOLEAN     NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── seed seats (idempotent) ──────────────────────────────────────────
    for (const row of ROWS) {
      for (let s = 1; s <= SEATS; s++) {
        const id = `${row}${s}`;
        await tx.query(
          `INSERT INTO seats (id, row_label, seat_number)
           VALUES ($1, $2, $3)
           ON CONFLICT (id) DO NOTHING`,
          [id, row, s]
        );
      }
    }
  });
}
