import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pglite');

let db;

export async function initDb() {
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  await createSchema();
  await seedDefaultColumns();
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

async function createSchema() {
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

    CREATE INDEX IF NOT EXISTS idx_cards_column_position
      ON cards (column_id, position);
  `);
}

async function seedDefaultColumns() {
  const result = await db.query('SELECT COUNT(*) AS cnt FROM columns');
  const count = parseInt(result.rows[0].cnt, 10);
  if (count > 0) return;

  await db.exec(`
    INSERT INTO columns (id, title, position) VALUES
      ('col-todo',        'To Do',       1000),
      ('col-inprogress',  'In Progress',  2000),
      ('col-done',        'Done',         3000);
  `);
}
