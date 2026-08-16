import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// PGlite uses a directory as its data store (not a single file)
const DATA_DIR = join(__dirname, '..', 'data', 'pgdata');

mkdirSync(DATA_DIR, { recursive: true });

let db;

export async function getDb() {
  if (db) return db;
  // Pass the directory path so PGlite persists to disk
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  return db;
}
