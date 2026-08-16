import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

// Ensure parent directory exists (PGlite manages the data dir itself).
fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });

let dbPromise = null;

export function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = new PGlite(DATA_DIR);
      await db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id        SERIAL PRIMARY KEY,
          title     TEXT NOT NULL,
          start_at  TIMESTAMPTZ NOT NULL,
          end_at    TIMESTAMPTZ NOT NULL,
          CONSTRAINT end_after_start CHECK (end_at > start_at)
        );
      `);
      return db;
    })();
  }
  return dbPromise;
}
