import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../../data/seatdb');

let db;

export async function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export async function initDb() {
  db = new PGlite(DB_PATH);
  await db.waitReady;

  // Create seats table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id            TEXT PRIMARY KEY,
      row_label     TEXT NOT NULL,
      seat_number   INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'available'
                      CHECK (status IN ('available', 'held', 'booked')),
      hold_id       TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by     TEXT,
      UNIQUE(row_label, seat_number)
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL,
      confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
      released    BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);

  // Seed seat map: 5 rows (A-E) × 10 seats if not already seeded
  const { rows } = await db.query('SELECT COUNT(*) as cnt FROM seats');
  const count = parseInt(rows[0].cnt, 10);

  if (count === 0) {
    const rows_labels = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    const insertValues = [];
    for (const row of rows_labels) {
      for (let s = 1; s <= seatsPerRow; s++) {
        const id = `${row}${s}`;
        insertValues.push(`('${id}', '${row}', ${s}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(`
      INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by)
      VALUES ${insertValues.join(',\n')}
      ON CONFLICT DO NOTHING;
    `);
    console.log('[DB] Seeded 50 seats (5 rows × 10 seats)');
  } else {
    console.log(`[DB] Found ${count} existing seats, skipping seed`);
  }

  console.log('[DB] Initialized at', DB_PATH);
  return db;
}

/**
 * Release all holds that have expired. Returns the list of seat IDs that were released.
 */
export async function sweepExpiredHolds(db) {
  // Find seats that are held but expired
  const { rows: expiredSeats } = await db.query(`
    SELECT s.id, s.hold_id
    FROM seats s
    WHERE s.status = 'held'
      AND s.hold_expires_at IS NOT NULL
      AND s.hold_expires_at < NOW()
  `);

  if (expiredSeats.length === 0) return [];

  // Release them
  await db.exec(`
    UPDATE seats
    SET status = 'available',
        hold_id = NULL,
        hold_expires_at = NULL
    WHERE status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at < NOW()
  `);

  // Mark holds as released
  const holdIds = [...new Set(expiredSeats.map(r => r.hold_id).filter(Boolean))];
  if (holdIds.length > 0) {
    const holdIdList = holdIds.map(id => `'${id}'`).join(',');
    await db.exec(`
      UPDATE holds
      SET released = TRUE
      WHERE id IN (${holdIdList})
        AND confirmed = FALSE
    `);
  }

  return expiredSeats.map(r => r.id);
}
