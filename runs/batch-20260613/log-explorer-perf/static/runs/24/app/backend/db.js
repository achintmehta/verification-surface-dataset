import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'pgdata');

let db = null;

export async function getDb() {
  if (db) return db;
  console.log(`Initializing PGLite at ${DB_PATH}...`);
  db = new PGlite(DB_PATH);
  // PGlite v0.2.x exposes a waitReady promise; safe to await even if already resolved
  if (db.waitReady) {
    await db.waitReady;
  }
  return db;
}

export async function closeDb() {
  if (db) {
    await db.close();
    db = null;
  }
}
