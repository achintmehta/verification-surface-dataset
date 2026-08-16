/**
 * Database module: initializes PGLite, creates schema, seeds seat map.
 *
 * All SQL that touches seat state uses SELECT … FOR UPDATE or conditional
 * UPDATE … WHERE status = 'available' so that concurrent transactions
 * serialize correctly at the row level.
 */

import { PGlite } from '@electric-sql/pglite';

// Allow tests to inject a pre-built instance.
let _db = null;

export function setDb(instance) {
  _db = instance;
}

export function getDb() {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return _db;
}

// Seat map configuration
export const ROWS = ['A', 'B', 'C', 'D', 'E'];
export const SEATS_PER_ROW = 10;
export const HOLD_TTL_SECONDS = 60; // 1 minute

/**
 * Initialize the database.
 *
 * @param {string|null} dataDir  - path for persistent storage, or null/undefined
 *                                 for in-memory (tests).
 * @param {object|null} instance - pre-built PGlite instance (tests).
 */
export async function initDb(dataDir, instance) {
  if (instance) {
    _db = instance;
  } else if (!_db) {
    _db = dataDir ? new PGlite(dataDir) : new PGlite();
  }

  await _db.waitReady;
  await createSchema(_db);
  await seedSeats(_db);

  return _db;
}

async function createSchema(db) {
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
      expires_at  TIMESTAMPTZ NOT NULL,
      confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);
    CREATE INDEX IF NOT EXISTS idx_seats_status  ON seats(status);
    CREATE INDEX IF NOT EXISTS idx_holds_expires ON holds(expires_at);
  `);
}

async function seedSeats(db) {
  // Only seed if the table is empty
  const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM seats');
  if (parseInt(rows[0].cnt, 10) > 0) return;

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
    `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')}
     ON CONFLICT DO NOTHING`,
    params
  );
}

/**
 * Release all holds whose expires_at is in the past.
 * Returns the list of seat ids that were released so callers can broadcast.
 */
export async function sweepExpiredHolds(db) {
  const released = [];

  await db.transaction(async (tx) => {
    // Find expired, unconfirmed holds
    const { rows: expiredHolds } = await tx.query(`
      SELECT id FROM holds
      WHERE expires_at <= NOW()
        AND confirmed = FALSE
    `);

    if (expiredHolds.length === 0) return;

    const holdIds = expiredHolds.map((h) => h.id);
    const placeholders = holdIds.map((_, i) => `$${i + 1}`).join(', ');

    // Release the seats belonging to those holds
    const { rows: releasedSeats } = await tx.query(
      `UPDATE seats
          SET status = 'available',
              hold_id = NULL,
              hold_expires_at = NULL
        WHERE hold_id = ANY(ARRAY[${placeholders}]::text[])
          AND status = 'held'
        RETURNING id`,
      holdIds
    );

    // Delete the expired holds
    await tx.query(
      `DELETE FROM holds WHERE id = ANY(ARRAY[${placeholders}]::text[])`,
      holdIds
    );

    releasedSeats.forEach((s) => released.push(s.id));
  });

  return released;
}
