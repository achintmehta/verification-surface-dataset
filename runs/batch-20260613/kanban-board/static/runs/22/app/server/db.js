import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'kanban');

/** @type {import('@electric-sql/pglite').PGlite | null} */
let db = null;

/**
 * Initialize PGLite and create schema + seed data if needed.
 * @returns {Promise<import('@electric-sql/pglite').PGlite>}
 */
export async function initDB() {
  if (db) return db;

  db = new PGlite(DB_PATH);

  // Create tables if they don't exist
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position);
    CREATE INDEX IF NOT EXISTS idx_columns_position ON columns(position);
  `);

  // Seed default columns if the table is empty
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
 * Get the initialised DB instance.
 * @returns {import('@electric-sql/pglite').PGlite}
 */
export function getDB() {
  if (!db) throw new Error('Database not initialised. Call initDB() first.');
  return db;
}
