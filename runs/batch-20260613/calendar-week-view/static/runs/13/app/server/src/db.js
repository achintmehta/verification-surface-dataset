import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist PGLite to the local filesystem so data survives restarts.
const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, '..', 'data', 'pgdata');

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  const db = new PGlite(DATA_DIR);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id        SERIAL PRIMARY KEY,
      title     TEXT NOT NULL,
      start_at  TIMESTAMPTZ NOT NULL,
      end_at    TIMESTAMPTZ NOT NULL,
      CONSTRAINT events_time_order CHECK (end_at > start_at)
    );
  `);
  dbInstance = db;
  return db;
}
