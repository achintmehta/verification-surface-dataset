import { PGlite } from "@electric-sql/pglite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "..", "data", "kanban");

let db: PGlite;

export async function getDb(): Promise<PGlite> {
  if (db) return db;
  db = new PGlite(DB_PATH);
  await initSchema(db);
  return db;
}

async function initSchema(db: PGlite): Promise<void> {
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position);
    CREATE INDEX IF NOT EXISTS idx_columns_position ON columns(position);
  `);

  // Seed default columns if none exist
  const result = await db.query("SELECT COUNT(*)::int AS cnt FROM columns");
  const row = result.rows[0] as { cnt: number };
  if (row.cnt === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES
        ('col-todo', 'To Do', 1000),
        ('col-in-progress', 'In Progress', 2000),
        ('col-done', 'Done', 3000);
    `);
  }
}
