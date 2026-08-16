import { PGlite } from "@electric-sql/pglite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "pgdata");

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  // Wait for PGlite to be ready before running schema
  if (db.waitReady) {
    await db.waitReady;
  }
  await initSchema();
  return db;
}

// Cleanly flush and close PGlite so the persisted data directory is not left
// in an inconsistent state on shutdown. An unclean exit can corrupt pgdata and
// cause "RuntimeError: Aborted()" on the next startup.
export async function closeDb() {
  if (!db) return;
  try {
    await db.close();
  } finally {
    db = undefined;
  }
}

async function initSchema() {
  // Create the seats table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      session_id TEXT,
      booked_by TEXT,
      UNIQUE(row_label, seat_number)
    );
  `);

  // Create a holds table to track hold metadata and enable idempotent confirmation
  await db.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_ids INTEGER[] NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    );
  `);

  // Seed the seat map: 5 rows (A-E) × 10 seats each = 50 seats
  const countResult = await db.query("SELECT COUNT(*) as cnt FROM seats");
  const count = parseInt(countResult.rows[0].cnt, 10);

  if (count === 0) {
    const rows = ["A", "B", "C", "D", "E"];
    const seatsPerRow = 10;
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const row of rows) {
      for (let seatNum = 1; seatNum <= seatsPerRow; seatNum++) {
        values.push(`($${paramIdx}, $${paramIdx + 1})`);
        params.push(row, seatNum);
        paramIdx += 2;
      }
    }

    await db.query(
      `INSERT INTO seats (row_label, seat_number) VALUES ${values.join(", ")}`,
      params
    );

    console.log(`Seeded ${rows.length * seatsPerRow} seats`);
  }
}

export default getDb;
