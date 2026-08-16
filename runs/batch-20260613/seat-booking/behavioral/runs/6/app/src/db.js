import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', '.pglite');

export const ROWS = ['A', 'B', 'C', 'D', 'E'];
export const SEATS_PER_ROW = 10;
export const TOTAL_SEATS = ROWS.length * SEATS_PER_ROW;

export const db = new PGlite(dataDir);

let readyPromise;

export async function initDb() {
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS seats (
        id INTEGER PRIMARY KEY,
        row_label TEXT NOT NULL,
        seat_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')) DEFAULT 'available',
        hold_id TEXT NULL,
        hold_expires_at TIMESTAMPTZ NULL,
        booked_by TEXT NULL,
        booked_at TIMESTAMPTZ NULL,
        UNIQUE (row_label, seat_number)
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS holds (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'confirmed', 'released', 'expired')) DEFAULT 'active',
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        confirmed_at TIMESTAMPTZ NULL,
        released_at TIMESTAMPTZ NULL,
        booking_id TEXT NULL,
        seat_count INTEGER NOT NULL
      )
    `);

    const count = await db.query('SELECT COUNT(*)::int AS count FROM seats');
    const existing = Number(count.rows[0]?.count || 0);

    if (existing === 0) {
      await db.query('BEGIN');
      try {
        let id = 1;
        for (const row of ROWS) {
          for (let seatNumber = 1; seatNumber <= SEATS_PER_ROW; seatNumber += 1) {
            await db.query(
              'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1, $2, $3, $4)',
              [id, row, seatNumber, 'available']
            );
            id += 1;
          }
        }
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    }
  })();

  return readyPromise;
}
