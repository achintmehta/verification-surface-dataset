import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pgdata');

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  // Ensure the parent directory exists so PGLite can create its data dir.
  fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });
  dbInstance = new PGlite(DATA_DIR);
  await dbInstance.waitReady;
  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      title TEXT NOT NULL,
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT end_after_start CHECK (end_at > start_at)
    );
  `);
  return dbInstance;
}
