const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

let db;

async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  await db.waitReady;
  return db;
}

async function initializeDatabase() {
  const pg = await getDb();

  // Create tables
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position FLOAT8 NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES columns(id),
      text TEXT NOT NULL,
      position FLOAT8 NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_id ON cards(column_id);
    CREATE INDEX IF NOT EXISTS idx_cards_position ON cards(column_id, position);
  `);

  // Seed default columns if none exist
  const { rows } = await pg.query('SELECT COUNT(*) as cnt FROM columns');
  if (parseInt(rows[0].cnt, 10) === 0) {
    await pg.exec(`
      INSERT INTO columns (id, title, position) VALUES
        ('col-todo', 'To Do', 1000),
        ('col-in-progress', 'In Progress', 2000),
        ('col-done', 'Done', 3000);
    `);
  }

  return pg;
}

module.exports = { getDb, initializeDatabase };
