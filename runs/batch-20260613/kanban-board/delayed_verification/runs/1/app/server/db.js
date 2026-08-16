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

  // Add unique constraint on (column_id, position) if not already present.
  // We do this as a separate step so it works on both fresh and existing DBs.
  // First resolve any pre-existing duplicates by renumbering them.
  await db.exec(`
    DO $$
    DECLARE
      dup RECORD;
      new_pos DOUBLE PRECISION;
    BEGIN
      -- Find duplicate (column_id, position) pairs and fix them
      FOR dup IN
        SELECT column_id, position
        FROM cards
        GROUP BY column_id, position
        HAVING COUNT(*) > 1
      LOOP
        -- Keep the first (by id), renumber the rest
        FOR dup IN
          SELECT id, column_id
          FROM cards
          WHERE column_id = dup.column_id AND position = dup.position
          ORDER BY created_at, id
          OFFSET 1
        LOOP
          SELECT COALESCE(MAX(position), 0) + 1000
          INTO new_pos
          FROM cards
          WHERE column_id = dup.column_id;
          UPDATE cards SET position = new_pos WHERE id = dup.id;
        END LOOP;
      END LOOP;
    END $$;
  `);

  // Now add the unique constraint if it doesn't exist
  const constraintCheck = await db.query(`
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cards_column_id_position_key'
  `);
  if (constraintCheck.rows.length === 0) {
    await db.exec('ALTER TABLE cards ADD CONSTRAINT cards_column_id_position_key UNIQUE (column_id, position)');
  }

  // Seed default columns only if none exist
  const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM columns');
  if (parseInt(rows[0].cnt, 10) === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES
        ('col-todo',       'To Do',       1000),
        ('col-inprogress', 'In Progress', 2000),
        ('col-done',       'Done',        3000);
    `);
  }

  console.log('[db] PGLite initialised at', DATA_DIR);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialised – call initDb() first');
  return db;
}
