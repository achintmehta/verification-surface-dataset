import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pglite');

let db;

export async function getDb() {
  if (!db) {
    db = new PGlite(DATA_DIR);
    await db.waitReady;
  }
  return db;
}

export async function initDb() {
  const db = await getDb();

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
      UNIQUE (row_label, seat_number)
    );
  `);

  // Create holds table for idempotent confirmation tracking
  await db.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed seat map: 5 rows (A–E) × 10 seats, only if empty
  const existing = await db.query(`SELECT COUNT(*) AS cnt FROM seats`);
  const count = parseInt(existing.rows[0].cnt, 10);

  if (count === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    const seatsPerRow = 10;
    const values = [];
    for (const row of rows) {
      for (let s = 1; s <= seatsPerRow; s++) {
        const id = `${row}${s}`;
        values.push(`('${id}', '${row}', ${s}, 'available', NULL, NULL, NULL)`);
      }
    }
    await db.exec(`
      INSERT INTO seats (id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by)
      VALUES ${values.join(',\n')}
      ON CONFLICT DO NOTHING;
    `);
    console.log(`[db] Seeded ${rows.length * seatsPerRow} seats.`);
  } else {
    console.log(`[db] Found ${count} existing seats, skipping seed.`);
  }

  console.log('[db] Database initialized.');
  return db;
}
