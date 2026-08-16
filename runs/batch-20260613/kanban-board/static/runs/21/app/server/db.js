import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'pgdata');

/** @type {import('@electric-sql/pglite').PGlite} */
let db;

/**
 * Initialize PGLite and create/migrate tables.
 * @returns {Promise<import('@electric-sql/pglite').PGlite>}
 */
export async function initDb() {
  db = new PGlite(DB_PATH);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      position    DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id          TEXT PRIMARY KEY,
      column_id   TEXT NOT NULL REFERENCES columns(id),
      text        TEXT NOT NULL,
      position    DOUBLE PRECISION NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position);
  `);

  // Seed default columns if none exist
  const { rows } = await db.query('SELECT COUNT(*)::int AS cnt FROM columns');
  if (rows[0].cnt === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES
        ('col-todo',        'To Do',        1000),
        ('col-in-progress', 'In Progress',  2000),
        ('col-done',        'Done',         3000);
    `);
  }

  return db;
}

/**
 * Return the initialized PGLite instance.
 * @returns {import('@electric-sql/pglite').PGlite}
 */
export function getDb() {
  if (!db) throw new Error('Database not initialized – call initDb() first');
  return db;
}
