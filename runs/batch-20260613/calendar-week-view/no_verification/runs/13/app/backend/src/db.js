import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Persist PGLite to the local filesystem so data survives restarts.
const DATA_DIR = path.resolve(__dirname, '..', 'data', 'pgdata');

// Ensure the parent data directory exists.
fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;

  const db = new PGlite(DATA_DIR);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id          SERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      start_at    TIMESTAMPTZ NOT NULL,
      end_at      TIMESTAMPTZ NOT NULL,
      CONSTRAINT end_after_start CHECK (end_at > start_at)
    );
  `);

  dbInstance = db;
  return db;
}
