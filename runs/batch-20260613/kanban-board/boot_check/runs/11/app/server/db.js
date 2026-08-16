import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the database durably on local disk. PGlite writes the entire
// PostgreSQL data directory under this path.
const DATA_DIR = process.env.PGLITE_DATA_DIR
  ? path.resolve(process.env.PGLITE_DATA_DIR)
  : path.join(__dirname, '..', '.data', 'kanban');

let db;

/**
 * Initialize the embedded PGLite database, create the schema if needed,
 * and seed default columns the first time the database is created.
 */
export async function initDb() {
  // PGLite's node filesystem backend does not create parent directories, so
  // ensure the full data directory exists before opening the database.
  fs.mkdirSync(DATA_DIR, { recursive: true });

  db = new PGlite(DATA_DIR);
  await db.waitReady;

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

    CREATE INDEX IF NOT EXISTS cards_column_position_idx
      ON cards (column_id, position);
  `);

  await seedDefaults();
  return db;
}

async function seedDefaults() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (rows[0].count > 0) return;

  const defaults = [
    { id: 'col-todo', title: 'To Do', position: 1000 },
    { id: 'col-doing', title: 'In Progress', position: 2000 },
    { id: 'col-done', title: 'Done', position: 3000 },
  ];

  for (const c of defaults) {
    await db.query(
      'INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)',
      [c.id, c.title, c.position]
    );
  }
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}
