import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pglite');

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DATA_DIR);
  await db.waitReady;
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
      status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed seat map: 5 rows (A-E) × 10 seats, only if empty
  const { rows } = await db.query(`SELECT COUNT(*) AS cnt FROM seats`);
  if (parseInt(rows[0].cnt, 10) === 0) {
    const rowLabels = ['A', 'B', 'C', 'D', 'E'];
    const seatCount = 10;
    const values = [];
    const params = [];
    let idx = 1;
    for (const row of rowLabels) {
      for (let s = 1; s <= seatCount; s++) {
        const id = `${row}${s}`;
        values.push(`($${idx++}, $${idx++}, $${idx++})`);
        params.push(id, row, s);
      }
    }
    await db.query(
      `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')}`,
      params
    );
    console.log('[db] Seeded 50 seats (5 rows × 10 seats)');
  }

  console.log('[db] Database initialized');
  return db;
}
