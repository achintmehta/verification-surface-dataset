import { PGlite } from "@electric-sql/pglite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "pgdata");

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
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
  await db.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_ids INTEGER[] NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'released', 'expired'))
    );
  `);

  // Seed seats if empty
  const countResult = await db.query("SELECT COUNT(*) as cnt FROM seats");
  const count = parseInt(countResult.rows[0].cnt, 10);

  if (count === 0) {
    const rows = ["A", "B", "C", "D", "E"];
    const seatsPerRow = 10;
    const values = [];
    for (const row of rows) {
      for (let s = 1; s <= seatsPerRow; s++) {
        values.push(`('${row}', ${s}, 'available')`);
      }
    }
    await db.exec(`INSERT INTO seats (row_label, seat_number, status) VALUES ${values.join(", ")}`);
    console.log(`Seeded ${rows.length * seatsPerRow} seats`);
  }

  return db;
}
