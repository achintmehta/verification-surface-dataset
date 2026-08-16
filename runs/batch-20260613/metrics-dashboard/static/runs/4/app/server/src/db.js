import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

mkdirSync(DATA_DIR, { recursive: true });

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(join(DATA_DIR, 'pglite'));
  await db.waitReady;
  return db;
}
