import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '.pgdata');

// Ensure the parent dir exists; PGlite manages the data dir itself.
if (!fs.existsSync(path.dirname(DATA_DIR))) {
  fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });
}

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  await initSchema(db);
  return db;
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id SERIAL PRIMARY KEY,
      column_id INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column ON cards(column_id, position);
  `);

  // Seed default columns only if none exist.
  const res = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  const count = res.rows[0].count;
  if (count === 0) {
    const defaults = ['To Do', 'In Progress', 'Done'];
    for (let i = 0; i < defaults.length; i++) {
      await db.query(
        'INSERT INTO columns (title, position) VALUES ($1, $2)',
        [defaults[i], (i + 1) * 1000]
      );
    }
  }
}
