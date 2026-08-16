import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../../data/pglite');

// Ensure the data directory exists
mkdirSync(DB_PATH, { recursive: true });

let db = null;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH, {
    extensions: { pg_trgm },
  });
  await db.waitReady;
  return db;
}
