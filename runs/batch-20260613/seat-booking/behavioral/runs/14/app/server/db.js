import { PGlite } from '@electric-sql/pglite';

/**
 * Create and initialize a PGlite database instance.
 *
 * @param {string} [dataDir] - Filesystem path for persistence. If omitted, an
 *                             in-memory database is used (useful for tests).
 * @returns {Promise<PGlite>}
 */
export async function createDb(dataDir) {
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  await initSchema(db);
  return db;
}

/**
 * Create the schema (idempotent) and seed the seat map if empty.
 *
 * Seat map: ROWS rows x SEATS_PER_ROW seats.
 */
export const ROWS = ['A', 'B', 'C', 'D', 'E'];
export const SEATS_PER_ROW = 10;

export async function initSchema(db) {
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
  `);

  const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM seats;');
  if (rows[0].c === 0) {
    // Seed the fixed seat map in a single transaction.
    await db.transaction(async (tx) => {
      for (const row of ROWS) {
        for (let n = 1; n <= SEATS_PER_ROW; n++) {
          const id = `${row}${n}`;
          await tx.query(
            `INSERT INTO seats (id, row_label, seat_number, status)
             VALUES ($1, $2, $3, 'available')`,
            [id, row, n]
          );
        }
      }
    });
  }
}
