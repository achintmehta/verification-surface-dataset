import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'seatdb');

/** @type {import('@electric-sql/pglite').PGlite | null} */
let db = null;

/**
 * Returns the singleton PGlite instance, initializing it on first call.
 * @returns {Promise<import('@electric-sql/pglite').PGlite>}
 */
export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  await initSchema(db);
  return db;
}

/**
 * Create tables and seed the fixed seat map if not already present.
 * @param {import('@electric-sql/pglite').PGlite} pg
 */
async function initSchema(pg) {
  // Create seats table
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id            SERIAL PRIMARY KEY,
      row_label     TEXT    NOT NULL,
      seat_number   INT     NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'available'
                      CHECK (status IN ('available', 'held', 'booked')),
      hold_id       TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by     TEXT,
      UNIQUE(row_label, seat_number)
    );
  `);

  // Create holds table for tracking hold metadata
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      id            TEXT    PRIMARY KEY,
      session_id    TEXT    NOT NULL,
      seat_ids      INT[]   NOT NULL,
      expires_at    TIMESTAMPTZ NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at  TIMESTAMPTZ
    );
  `);

  // Seed 5 rows (A-E) × 10 seats if the table is empty
  const { rows } = await pg.query('SELECT COUNT(*)::int AS cnt FROM seats');
  const count = rows[0]?.cnt ?? 0;
  if (count === 0) {
    const rowLabels = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    const values = [];
    for (const label of rowLabels) {
      for (let s = 1; s <= seatsPerRow; s++) {
        values.push(`('${label}', ${s}, 'available')`);
      }
    }
    await pg.exec(`INSERT INTO seats (row_label, seat_number, status) VALUES ${values.join(',')};`);
    console.log(`Seeded ${rowLabels.length * seatsPerRow} seats.`);
  }
}

export default getDb;
