import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, '..', 'data', 'pgdata');

let dbPromise = null;

export function getDb() {
  if (!dbPromise) {
    dbPromise = init();
  }
  return dbPromise;
}

async function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new PGlite(DATA_DIR);
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
