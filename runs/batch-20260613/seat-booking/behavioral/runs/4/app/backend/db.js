import { PGlite } from "@electric-sql/pglite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Allow tests to inject an in-memory instance
let _db = null;

export function setDb(instance) {
  _db = instance;
}

export async function getDb() {
  if (_db) return _db;
  const dbPath = path.join(__dirname, "..", "data", "seats.db");
  _db = new PGlite(`file://${dbPath}`);
  await _db.waitReady;
  return _db;
}

export async function initDb(db) {
  // Create seats table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id            TEXT PRIMARY KEY,
      row_label     TEXT NOT NULL,
      seat_number   INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'available'
                      CHECK (status IN ('available','held','booked')),
      hold_id       TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by     TEXT,
      UNIQUE (row_label, seat_number)
    );

    CREATE TABLE IF NOT EXISTS holds (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      expires_at    TIMESTAMPTZ NOT NULL,
      confirmed     BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed seats only if the table is empty
  const { rows } = await db.query(`SELECT COUNT(*) AS cnt FROM seats`);
  if (parseInt(rows[0].cnt, 10) === 0) {
    const rows_labels = ["A", "B", "C", "D", "E"];
    const seatsPerRow = 10;
    const values = [];
    for (const row of rows_labels) {
      for (let s = 1; s <= seatsPerRow; s++) {
        values.push(`('${row}${s}', '${row}', ${s}, 'available')`);
      }
    }
    await db.exec(
      `INSERT INTO seats (id, row_label, seat_number, status) VALUES ${values.join(",")};`
    );
  }
}
