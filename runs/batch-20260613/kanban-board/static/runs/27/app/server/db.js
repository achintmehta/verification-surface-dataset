import { PGlite } from '@electric-sql/pglite';

const db = new PGlite({
  dataDir: './kanban-data'
});

let initialized = false;

export async function initDb() {
  if (initialized) return db;
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position REAL NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES columns(id),
      text TEXT NOT NULL,
      position REAL NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed default columns if none exist
  const { rows } = await db.query('SELECT COUNT(*) as count FROM columns');
  if (parseInt(rows[0].count) === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES 
      ('col-todo', 'To Do', 1),
      ('col-progress', 'In Progress', 2),
      ('col-done', 'Done', 3);
    `);
  }
  
  initialized = true;
  return db;
}

export { db };