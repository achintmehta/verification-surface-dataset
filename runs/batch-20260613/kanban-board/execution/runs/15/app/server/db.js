import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// PGLite persists to a directory on local disk so board state is durable
// across restarts.
const DATA_DIR = process.env.PGLITE_DATA_DIR
  ? path.resolve(process.env.PGLITE_DATA_DIR)
  : path.join(__dirname, '..', '.pgdata');

let dbInstance = null;

/**
 * Returns a singleton PGLite instance, creating + initializing it on first call.
 */
export async function getDb() {
  if (dbInstance) return dbInstance;

  // Ensure the parent directory exists.
  fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });

  const db = new PGlite(DATA_DIR);
  await db.waitReady;
  await initSchema(db);
  dbInstance = db;
  return db;
}

/**
 * Creates the columns and cards tables (idempotently) and seeds default
 * columns if the board is empty.
 */
async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id       TEXT PRIMARY KEY,
      title    TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id         TEXT PRIMARY KEY,
      column_id  TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text       TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position
      ON cards (column_id, position);
  `);

  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (rows[0].count === 0) {
    await seedDefaults(db);
  }
}

async function seedDefaults(db) {
  const defaults = [
    { id: 'col-todo', title: 'To Do', position: 1000 },
    { id: 'col-progress', title: 'In Progress', position: 2000 },
    { id: 'col-done', title: 'Done', position: 3000 },
  ];
  for (const col of defaults) {
    await db.query(
      'INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)',
      [col.id, col.title, col.position]
    );
  }
}
