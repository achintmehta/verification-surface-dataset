/**
 * Database module – initialises PGLite and exposes a ready promise.
 *
 * PGLite is an embedded PostgreSQL engine that persists to the local
 * filesystem.  We keep a single shared instance for the whole server
 * process so that all requests share the same connection / WAL.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pglite');

// Create a single PGLite instance backed by the local filesystem.
export const db = new PGlite(`file://${DATA_DIR}`);

/**
 * Initialise the schema and seed default columns if the database is empty.
 * Returns a promise that resolves once the DB is ready to accept queries.
 */
export async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id         TEXT PRIMARY KEY,
      column_id  TEXT NOT NULL REFERENCES columns(id),
      text       TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS cards_column_position
      ON cards (column_id, position);
  `);

  // Seed default columns only when the table is empty.
  const { rows } = await db.query(`SELECT COUNT(*) AS cnt FROM columns`);
  const count = parseInt(rows[0].cnt, 10);

  if (count === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES
        ('col-todo',        'To Do',       1000),
        ('col-inprogress',  'In Progress', 2000),
        ('col-done',        'Done',        3000);
    `);
    console.log('[db] Seeded default columns.');
  }

  console.log('[db] Database ready.');
}
