import { PGlite } from "@electric-sql/pglite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "pgdata");

/** @type {PGlite | null} */
let db = null;

/**
 * Get (or create) the singleton PGlite instance.
 * @returns {Promise<PGlite>}
 */
export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  await db.waitReady;
  return db;
}

/**
 * Initialise the schema and seed data (idempotent).
 * @param {PGlite} db
 */
export async function initSchema(db) {
  // Create seats table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id            SERIAL PRIMARY KEY,
      row_label     TEXT    NOT NULL,
      seat_number   INT     NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'available'
                      CHECK (status IN ('available', 'held', 'booked')),
      hold_id       TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by     TEXT,
      session_id    TEXT,
      UNIQUE (row_label, seat_number)
    );
  `);

  // Create holds table for tracking hold metadata
  await db.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      seat_ids    INT[] NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'confirmed', 'released', 'expired'))
    );
  `);

  // Seed the seat map if empty: 5 rows (A-E) × 10 seats
  const { rows } = await db.query("SELECT COUNT(*)::int AS cnt FROM seats");
  const count = rows[0]?.cnt ?? 0;
  if (count === 0) {
    const rowLabels = ["A", "B", "C", "D", "E"];
    const seatsPerRow = 10;
    const values = [];
    const params = [];
    let idx = 1;
    for (const rowLabel of rowLabels) {
      for (let seatNum = 1; seatNum <= seatsPerRow; seatNum++) {
        values.push(`($${idx}, $${idx + 1})`);
        params.push(rowLabel, seatNum);
        idx += 2;
      }
    }
    await db.query(
      `INSERT INTO seats (row_label, seat_number) VALUES ${values.join(", ")}`,
      params
    );
    console.log(`Seeded ${rowLabels.length * seatsPerRow} seats.`);
  }
}
