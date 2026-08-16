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
  await initSchema(db);
  return db;
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES columns(id),
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_id ON cards(column_id);
    CREATE INDEX IF NOT EXISTS idx_cards_position ON cards(column_id, position);
  `);

  // Seed default columns if empty
  const { rows } = await db.query("SELECT COUNT(*) as cnt FROM columns");
  if (parseInt(rows[0].cnt, 10) === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES
        ('col-todo', 'To Do', 1000),
        ('col-in-progress', 'In Progress', 2000),
        ('col-done', 'Done', 3000);
    `);
  }
}
