import { PGlite } from "@electric-sql/pglite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "pgdata");

/** @type {PGlite | null} */
let db = null;

/**
 * Get or create the PGlite database instance.
 * @returns {Promise<PGlite>}
 */
export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  await initSchema(db);
  return db;
}

/**
 * Initialize the database schema and seed data.
 * @param {PGlite} database
 */
async function initSchema(database) {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id            SERIAL PRIMARY KEY,
      row_label     TEXT    NOT NULL,
      seat_number   INTEGER NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'available'
                      CHECK (status IN ('available', 'held', 'booked')),
      hold_id       TEXT,
      hold_expires_at TIMESTAMPTZ,
      session_id    TEXT,
      booked_by     TEXT,
      UNIQUE(row_label, seat_number)
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      seat_ids    INTEGER[] NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    );
  `);

  // Seed if empty
  const countResult = await database.query("SELECT COUNT(*)::int AS cnt FROM seats");
  const count = countResult.rows[0]?.cnt ?? 0;
  if (count === 0) {
    const rows = ["A", "B", "C", "D", "E"];
    const seatsPerRow = 10;
    const values = [];
    const params = [];
    let idx = 1;
    for (const rowLabel of rows) {
      for (let seatNum = 1; seatNum <= seatsPerRow; seatNum++) {
        values.push(`($${idx}, $${idx + 1})`);
        params.push(rowLabel, seatNum);
        idx += 2;
      }
    }
    await database.query(
      `INSERT INTO seats (row_label, seat_number) VALUES ${values.join(", ")}`,
      params
    );
    console.log(`Seeded ${rows.length * seatsPerRow} seats`);
  }
}
