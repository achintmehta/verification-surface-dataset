import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, 'data', 'pgdata');

let db;

export async function getDb() {
  if (db) return db;
  // Ensure the parent directory exists; PGlite will create the data dir itself.
  fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT end_after_start CHECK (end_at > start_at)
    );
  `);
  return db;
}
