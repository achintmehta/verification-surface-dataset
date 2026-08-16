import { PGlite } from "@electric-sql/pglite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "pgdata");

/** @type {import("@electric-sql/pglite").PGlite | null} */
let db = null;

/**
 * Get or create the PGlite database instance.
 * @returns {Promise<import("@electric-sql/pglite").PGlite>}
 */
export async function getDb() {
  if (db) return db;
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  await initSchema(db);
  return db;
}

/**
 * Create tables and seed default columns if they don't already exist.
 * @param {import("@electric-sql/pglite").PGlite} pg
 */
async function initSchema(pg) {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id         TEXT PRIMARY KEY,
      column_id  TEXT NOT NULL REFERENCES columns(id),
      text       TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position
      ON cards (column_id, position);
  `);

  // Seed default columns if none exist
  const { rows } = await pg.query("SELECT COUNT(*)::int AS cnt FROM columns");
  if (rows[0].cnt === 0) {
    await pg.exec(`
      INSERT INTO columns (id, title, position) VALUES
        ('col-todo',        'To Do',        1),
        ('col-in-progress', 'In Progress',  2),
        ('col-done',        'Done',         3);
    `);
  }
}
