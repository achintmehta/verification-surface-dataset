import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'data', 'kanban-db');

let db: PGlite;

export async function getDb(): Promise<PGlite> {
  if (!db) {
    db = new PGlite(DB_PATH);
    await initializeSchema(db);
  }
  return db;
}

async function initializeSchema(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      column_id UUID NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position);
    CREATE INDEX IF NOT EXISTS idx_columns_position ON columns(position);
  `);

  // Seed default columns if none exist
  const result = await db.query<{ count: string }>('SELECT COUNT(*)::text as count FROM columns');
  const count = parseInt(result.rows[0].count, 10);

  if (count === 0) {
    await db.exec(`
      INSERT INTO columns (title, position) VALUES
        ('To Do', 1000),
        ('In Progress', 2000),
        ('Done', 3000);
    `);
  }
}
