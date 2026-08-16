import { PGlite } from '@electric-sql/pglite';
import { ROW_LABELS, SEATS_PER_ROW, DB_DIR } from './config.js';

let db = null;

/**
 * Initialize (or open) the embedded PGLite database, create the schema and
 * seed the fixed seat map. Idempotent: safe to call repeatedly.
 */
export async function initDb() {
  if (db) return db;

  db = new PGlite(DB_DIR);
  await db.waitReady;

  // Schema. A held seat carries a hold_id + hold_expires_at. A booked seat
  // carries booked_by (the session id that confirmed it).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id              INTEGER PRIMARY KEY,
      row_label       TEXT    NOT NULL,
      seat_number     INTEGER NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'available'
                              CHECK (status IN ('available','held','booked')),
      hold_id         TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by       TEXT,
      UNIQUE (row_label, seat_number)
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT        NOT NULL,
      seat_ids    INTEGER[]   NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      status      TEXT        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','confirmed','released','expired'))
    );

    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats (status);
    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats (hold_id);
    CREATE INDEX IF NOT EXISTS idx_holds_status ON holds (status);
  `);

  // Seed seats only if the table is empty.
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (rows[0].count === 0) {
    let id = 1;
    const values = [];
    const params = [];
    let p = 1;
    for (const rowLabel of ROW_LABELS) {
      for (let n = 1; n <= SEATS_PER_ROW; n++) {
        values.push(`($${p++}, $${p++}, $${p++})`);
        params.push(id, rowLabel, n);
        id++;
      }
    }
    await db.query(
      `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(',')}`,
      params
    );
  }

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}
