import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, '..', '.pgdata');

let db;

/**
 * Initialize PGLite (persisting to local disk), create schema, and seed
 * default columns if the board is empty.
 */
export async function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new PGlite(DATA_DIR);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id         TEXT PRIMARY KEY,
      column_id  TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text       TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column ON cards (column_id, position);
  `);

  await seedDefaults();
  return db;
}

async function seedDefaults() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM columns');
  if (rows[0].n > 0) return;

  const defaults = [
    { title: 'To Do', position: 1000 },
    { title: 'In Progress', position: 2000 },
    { title: 'Done', position: 3000 },
  ];
  for (const c of defaults) {
    await db.query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)', [
      newId('col'),
      c.title,
      c.position,
    ]);
  }
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

/** Generate a sortable-ish unique id. */
export function newId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
