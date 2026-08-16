import { PGlite } from "@electric-sql/pglite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "seatdb");

/** @type {PGlite | undefined} */
let db;

/**
 * Get or create the PGlite database instance.
 * @returns {Promise<PGlite>}
 */
export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  await db.waitReady;
  return db;
}

/**
 * Initialize the database schema and seed data.
 * @returns {Promise<PGlite>}
 */
export async function initializeDatabase() {
  const database = await getDb();

  // Create the seats table
  await database.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT,
      UNIQUE(row_label, seat_number)
    );
  `);

  // Create the holds table to track hold metadata
  await database.exec(`
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

  // Seed the seat map if empty: 5 rows (A-E) × 10 seats
  const countResult = await database.query("SELECT COUNT(*) as count FROM seats");
  const seatCount = parseInt(countResult.rows[0].count, 10);

  if (seatCount === 0) {
    const rows = ["A", "B", "C", "D", "E"];
    const seatsPerRow = 10;
    const values = [];

    for (const rowLabel of rows) {
      for (let seatNum = 1; seatNum <= seatsPerRow; seatNum++) {
        values.push(`('${rowLabel}', ${seatNum}, 'available')`);
      }
    }

    await database.exec(`
      INSERT INTO seats (row_label, seat_number, status)
      VALUES ${values.join(", ")};
    `);

    console.log(`Seeded ${rows.length * seatsPerRow} seats (${rows.length} rows × ${seatsPerRow} seats)`);
  }

  return database;
}
