/**
 * db.js – PGLite initialisation and schema bootstrap.
 *
 * PGLite is an embedded PostgreSQL engine that runs inside Node.js and
 * persists data to the local file system.  We keep a single module-level
 * instance so every part of the server shares the same connection.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pglite');

// Ensure the data directory exists before PGLite tries to use it.
fs.mkdirSync(DATA_DIR, { recursive: true });

let db;

/**
 * Return the shared PGLite instance, creating and bootstrapping it on the
 * first call.
 */
export async function getDb() {
  if (db) return db;

  db = new PGlite(DATA_DIR);

  await db.exec(`
    -- Columns table --------------------------------------------------------
    CREATE TABLE IF NOT EXISTS columns (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL
    );

    -- Cards table ----------------------------------------------------------
    CREATE TABLE IF NOT EXISTS cards (
      id         TEXT PRIMARY KEY,
      column_id  TEXT NOT NULL REFERENCES columns(id),
      text       TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Indices for fast per-column ordered queries --------------------------
    CREATE INDEX IF NOT EXISTS idx_cards_column_position
      ON cards (column_id, position);
  `);

  // Seed default columns only when the table is empty so we don't duplicate
  // them on server restart.
  const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM columns');
  if (Number(rows[0].cnt) === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES
        ('col-todo',        'To Do',       1000),
        ('col-inprogress',  'In Progress', 2000),
        ('col-done',        'Done',        3000);
    `);
  }

  return db;
}
