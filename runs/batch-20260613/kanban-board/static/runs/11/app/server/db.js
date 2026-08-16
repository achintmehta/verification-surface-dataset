import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// PGLite persists to a directory on local disk so board state survives restarts.
const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, '..', '.pgdata');

let dbInstance = null;

/**
 * Initialize (or return the existing) PGLite database, create the schema,
 * and seed default columns on first run.
 */
export async function getDb() {
  if (dbInstance) return dbInstance;

  const db = new PGlite(DATA_DIR);
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

    CREATE INDEX IF NOT EXISTS idx_cards_column_position
      ON cards (column_id, position);
  `);

  // Seed default columns only when the board is empty.
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (rows[0].count === 0) {
    const defaults = [
      { id: 'col-todo', title: 'To Do', position: 1024 },
      { id: 'col-doing', title: 'In Progress', position: 2048 },
      { id: 'col-done', title: 'Done', position: 3072 },
    ];
    for (const c of defaults) {
      await db.query(
        'INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)',
        [c.id, c.title, c.position]
      );
    }
  }

  dbInstance = db;
  return db;
}
