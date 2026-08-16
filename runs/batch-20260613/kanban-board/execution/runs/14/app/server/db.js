import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the database to local disk so board state is durable across restarts.
const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, '..', 'data', 'pgdata');

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  // PGLite's node FS does not create parent directories; ensure they exist.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  dbInstance = new PGlite(DATA_DIR);
  await dbInstance.waitReady;
  await initSchema(dbInstance);
  return dbInstance;
}

async function initSchema(db) {
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

    CREATE INDEX IF NOT EXISTS idx_cards_column ON cards(column_id, position);
  `);

  // Seed default columns once (only if the table is empty).
  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM columns`);
  if (rows[0].n === 0) {
    const defaults = [
      { id: 'col-todo', title: 'To Do', position: 1024 },
      { id: 'col-progress', title: 'In Progress', position: 2048 },
      { id: 'col-done', title: 'Done', position: 3072 }
    ];
    for (const c of defaults) {
      await db.query(
        `INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)`,
        [c.id, c.title, c.position]
      );
    }
  }
}
