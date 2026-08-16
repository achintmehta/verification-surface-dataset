import { PGlite } from "@electric-sql/pglite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.NODE_ENV === "test" 
  ? undefined  // in-memory for tests
  : path.join(__dirname, "..", "pgdata");

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  await db.waitReady;
  return db;
}

export async function initDb() {
  const pg = await getDb();

  await pg.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id            SERIAL PRIMARY KEY,
      row_label     TEXT NOT NULL,
      seat_number   INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'available'
                      CHECK (status IN ('available', 'held', 'booked')),
      hold_id       TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by     TEXT,
      session_id    TEXT,
      UNIQUE(row_label, seat_number)
    );
  `);

  // Seed the seat map if empty (5 rows A-E × 10 seats)
  const { rows } = await pg.query("SELECT count(*)::int AS cnt FROM seats");
  if (rows[0].cnt === 0) {
    const labels = ["A", "B", "C", "D", "E"];
    const values = [];
    const params = [];
    let idx = 1;
    for (const label of labels) {
      for (let s = 1; s <= 10; s++) {
        values.push(`($${idx}, $${idx + 1})`);
        params.push(label, s);
        idx += 2;
      }
    }
    await pg.query(
      `INSERT INTO seats (row_label, seat_number) VALUES ${values.join(", ")}`,
      params
    );
  }

  return pg;
}
