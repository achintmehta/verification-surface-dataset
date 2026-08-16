const { PGlite } = require("@electric-sql/pglite");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "pgdata");

let db;

async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  await db.waitReady;
  await initSchema();
  return db;
}

async function initSchema() {
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

  // Seed default columns if empty
  const { rows } = await db.query("SELECT COUNT(*)::int AS cnt FROM columns");
  if (rows[0].cnt === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES
        ('col-todo', 'To Do', 1000),
        ('col-inprogress', 'In Progress', 2000),
        ('col-done', 'Done', 3000);
    `);
  }
}

module.exports = { getDb };
