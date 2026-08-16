/**
 * Database module: initializes PGLite with file-system persistence,
 * creates the schema, and seeds default columns.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data/pglite');

let db;

export async function initDb() {
  db = new PGlite(`file://${DATA_DIR}`);
  await db.waitReady;

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id        TEXT PRIMARY KEY,
      title     TEXT NOT NULL,
      position  DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id         TEXT PRIMARY KEY,
      column_id  TEXT NOT NULL REFERENCES columns(id),
      text       TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS cards_column_position ON cards(column_id, position);
  `);

  // Seed default columns only if none exist
  const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM columns');
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

  console.log(`[db] PGLite ready at ${DATA_DIR}`);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}
