const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

let db;

async function initDb() {
  const dataDir = path.join(__dirname, '..', 'pgdata');
  db = new PGlite(dataDir);

  // Create tables
  await db.exec(`
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

    CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position);
    CREATE INDEX IF NOT EXISTS idx_columns_position ON columns(position);
  `);

  // Seed default columns if empty
  const result = await db.query('SELECT COUNT(*) as count FROM columns');
  const count = parseInt(result.rows[0].count, 10);

  if (count === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES
        ('col-todo', 'To Do', 1000),
        ('col-in-progress', 'In Progress', 2000),
        ('col-done', 'Done', 3000);
    `);
  }

  console.log('Database initialized');
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

module.exports = { initDb, getDb };
