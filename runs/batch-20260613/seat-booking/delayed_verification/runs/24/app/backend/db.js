import { PGlite } from "@electric-sql/pglite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "pgdata");

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  // PGlite v0.2.x: waitReady is a promise property
  if (db.waitReady) {
    await db.waitReady;
  }
  return db;
}

export async function initDb() {
  const pg = await getDb();

  // Create seats table
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_session_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT,
      UNIQUE(row_label, seat_number)
    );
  `);

  // Create holds table to track hold metadata
  // Using TEXT for seat_ids to store JSON array (portable across PGlite versions)
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_ids TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    );
  `);

  // Create indexes for common queries
  await pg.exec(`
    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats (status);
    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats (hold_id);
    CREATE INDEX IF NOT EXISTS idx_holds_status ON holds (status);
    CREATE INDEX IF NOT EXISTS idx_holds_expires_at ON holds (expires_at);
  `);

  // Seed the seat map if empty: 5 rows (A-E) × 10 seats
  const countResult = await pg.query("SELECT COUNT(*)::int as cnt FROM seats");
  const count = countResult.rows[0].cnt;

  if (count === 0) {
    const rows = ["A", "B", "C", "D", "E"];
    const seatsPerRow = 10;
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const rowLabel of rows) {
      for (let s = 1; s <= seatsPerRow; s++) {
        values.push(`($${paramIdx}, $${paramIdx + 1})`);
        params.push(rowLabel, s);
        paramIdx += 2;
      }
    }

    await pg.query(
      `INSERT INTO seats (row_label, seat_number) VALUES ${values.join(", ")}`,
      params
    );
    console.log(`Seeded ${rows.length * seatsPerRow} seats`);
  }

  return pg;
}
