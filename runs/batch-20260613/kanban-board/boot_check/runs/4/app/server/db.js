import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pglite');

let db;

export async function initDb() {
  // Ensure the data directory exists before PGLite tries to use it
  fs.mkdirSync(DATA_DIR, { recursive: true });

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
      id        TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      title     TEXT NOT NULL,
      position  DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      column_id  TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text       TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS cards_column_position ON cards(column_id, position);
  `);
}

async function seedDefaultColumns() {
  const result = await db.query('SELECT COUNT(*) AS cnt FROM columns');
  const count = parseInt(result.rows[0].cnt, 10);
  if (count === 0) {
    await db.exec(`
      INSERT INTO columns (title, position) VALUES
        ('To Do',       1000),
        ('In Progress', 2000),
        ('Done',        3000);
    `);
  }
}
