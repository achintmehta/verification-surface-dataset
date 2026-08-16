import { PGlite } from '@electric-sql/pglite';
import { config, rowLabel } from './config.js';

let dbInstance = null;

/**
 * Initialise (or open) the embedded PGLite database, create the schema and
 * seed the fixed seat map. Idempotent: re-running will not duplicate seats.
 */
export async function initDb() {
  if (dbInstance) return dbInstance;

  const db = new PGlite(config.dataDir);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id              SERIAL PRIMARY KEY,
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
      hold_id     TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      -- status: active | confirmed | released | expired
      status      TEXT NOT NULL DEFAULT 'active',
      confirmed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats (hold_id);
    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats (status);
  `);

  // Seed the seat map only if it is empty.
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (rows[0].count === 0) {
    await db.transaction(async (tx) => {
      for (let r = 0; r < config.rows; r++) {
        const label = rowLabel(r);
        for (let s = 1; s <= config.seatsPerRow; s++) {
          await tx.query(
            'INSERT INTO seats (row_label, seat_number, status) VALUES ($1, $2, $3)',
            [label, s, 'available']
          );
        }
      }
    });
  }

  dbInstance = db;
  return db;
}

export function getDb() {
  if (!dbInstance) throw new Error('Database not initialised. Call initDb() first.');
  return dbInstance;
}
