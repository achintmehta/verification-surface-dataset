import { PGlite } from "@electric-sql/pglite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db;

export async function getDb() {
  if (db) return db;
  const dbPath = path.join(__dirname, "..", "pgdata");
  db = new PGlite(dbPath);
  await db.waitReady;
  return db;
}

export async function initDb() {
  const db = await getDb();

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

  // Create holds table to track hold metadata
  // Using seat_ids_json (TEXT) instead of INTEGER[] for PGLite compatibility
  await db.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_ids_json TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'released', 'expired'))
    );
  `);

  // Seed the seat map if empty (5 rows x 10 seats)
  const countResult = await db.query("SELECT COUNT(*) as cnt FROM seats");
  const count = parseInt(countResult.rows[0].cnt, 10);

  if (count === 0) {
    const rows = ["A", "B", "C", "D", "E"];
    const seatsPerRow = 10;
    const values = [];
    const params = [];
    let paramIndex = 1;

    for (const row of rows) {
      for (let seatNum = 1; seatNum <= seatsPerRow; seatNum++) {
        values.push(`($${paramIndex}, $${paramIndex + 1})`);
        params.push(row, seatNum);
        paramIndex += 2;
      }
    }

    await db.query(
      `INSERT INTO seats (row_label, seat_number) VALUES ${values.join(", ")}`,
      params
    );
    console.log(`Seeded ${rows.length * seatsPerRow} seats.`);
  }

  return db;
}
