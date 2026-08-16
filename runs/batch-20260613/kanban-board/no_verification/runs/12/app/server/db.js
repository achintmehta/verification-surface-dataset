import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// PGLite persists to local disk under server/.pgdata
const DATA_DIR = path.join(__dirname, '.pgdata');

let dbInstance = null;

/**
 * Returns a singleton PGLite instance, initializing the schema and
 * seeding default columns on first use.
 */
export async function getDb() {
  if (dbInstance) return dbInstance;

  const db = new PGlite(DATA_DIR);
  await db.waitReady;

  await initSchema(db);
  await seedDefaults(db);

  dbInstance = db;
  return dbInstance;
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

    CREATE INDEX IF NOT EXISTS idx_cards_column ON cards(column_id, position);
  `);
}

async function seedDefaults(db) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (rows[0].count > 0) return;

  const defaults = [
    { id: 'col-todo', title: 'To Do', position: 1000 },
    { id: 'col-progress', title: 'In Progress', position: 2000 },
    { id: 'col-done', title: 'Done', position: 3000 }
  ];

  for (const col of defaults) {
    await db.query(
      'INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)',
      [col.id, col.title, col.position]
    );
  }
}
