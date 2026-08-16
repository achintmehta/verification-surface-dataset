import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data/pglite');

let db;

export async function initDb() {
  db = new PGlite(`file://${DATA_DIR}`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      text        TEXT        NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log(`[db] PGLite initialised — persisting to ${DATA_DIR}`);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialised. Call initDb() first.');
  return db;
}
