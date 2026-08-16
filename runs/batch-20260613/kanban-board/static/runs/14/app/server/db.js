import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Persist board state durably to local disk under server/.data/kanban.
const DATA_DIR = process.env.PGLITE_DIR || join(__dirname, '.data', 'kanban');

let dbInstance = null;

/**
 * Returns a singleton PGlite instance, initializing the schema and seeding
 * default columns the first time it is created.
 */
export async function getDb() {
  if (dbInstance) return dbInstance;

  const db = new PGlite(DATA_DIR);
  await db.waitReady;
  await initSchema(db);
  dbInstance = db;
  return db;
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      position    DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id          TEXT PRIMARY KEY,
      column_id   TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text        TEXT NOT NULL,
      position    DOUBLE PRECISION NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position
      ON cards (column_id, position);
  `);

  // Seed default columns only if the board is empty.
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (rows[0].count === 0) {
    const defaults = [
      { id: 'col-todo', title: 'To Do', position: 1024 },
      { id: 'col-progress', title: 'In Progress', position: 2048 },
      { id: 'col-done', title: 'Done', position: 3072 },
    ];
    for (const col of defaults) {
      await db.query(
        'INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)',
        [col.id, col.title, col.position]
      );
    }
  }
}
