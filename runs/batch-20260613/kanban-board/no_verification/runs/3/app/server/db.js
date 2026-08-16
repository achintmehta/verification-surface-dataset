/**
 * Database layer: embedded PGLite instance persisted to local disk.
 * Exports an initialised `db` object and a `ready` promise that resolves
 * once the schema has been created and default columns seeded.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data/pglite');

// PGLite instance – persisted to disk so state survives restarts.
export const db = new PGlite(`file://${DATA_DIR}`);

// ---------------------------------------------------------------------------
// Schema & seed
// ---------------------------------------------------------------------------

const INIT_SQL = `
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
`;

const SEED_SQL = `
  INSERT INTO columns (id, title, position) VALUES
    ('col-todo',        'To Do',       1000),
    ('col-inprogress',  'In Progress', 2000),
    ('col-done',        'Done',        3000)
  ON CONFLICT (id) DO NOTHING;
`;

export const ready = (async () => {
  await db.exec(INIT_SQL);
  await db.exec(SEED_SQL);
})();
