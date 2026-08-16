import { PGlite } from '@electric-sql/pglite';
import { DATA_DIR, ROW_LABELS, SEATS_PER_ROW } from './config.js';

let db = null;

/**
 * Initialize the embedded PGLite database, create the schema and seed the
 * fixed seat map (idempotently).
 */
export async function initDb() {
  if (db) return db;

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
  `);

  // Seed the fixed seat map only if empty.
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats;');
  if (rows[0].count === 0) {
    await db.transaction(async (tx) => {
      for (const rowLabel of ROW_LABELS) {
        for (let n = 1; n <= SEATS_PER_ROW; n += 1) {
          const id = `${rowLabel}${n}`;
          await tx.query(
            `INSERT INTO seats (id, row_label, seat_number, status)
             VALUES ($1, $2, $3, 'available');`,
            [id, rowLabel, n]
          );
        }
      }
    });
  }

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}
