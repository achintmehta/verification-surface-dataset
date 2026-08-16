import { PGlite } from '@electric-sql/pglite';

let db = null;
const connections = new Set();

export async function initDB() {
  if (db) return db;

  // Persist to local disk
  db = new PGlite('./data');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT REFERENCES columns(id) ON DELETE CASCADE,
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

  return db;
}

export function getDB() {
  if (!db) throw new Error('DB not initialized');
  return db;
}

// Broadcast to all SSE clients
export function broadcast(event) {
  const message = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of connections) {
    res.write(message);
  }
}

export function addConnection(res) {
  connections.add(res);
  return () => connections.delete(res);
}

export function getConnections() {
  return connections;
}