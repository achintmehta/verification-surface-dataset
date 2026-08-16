import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the database to the local file system. PGlite stores its data
// directory on disk so messages survive server restarts.
const DATA_DIR = process.env.PGLITE_DATA_DIR
  ? path.resolve(process.env.PGLITE_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'pgdata');

let dbPromise = null;

/**
 * Returns a singleton PGlite instance, initializing the schema on first use.
 * @returns {Promise<import('@electric-sql/pglite').PGlite>}
 */
export function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      // PGlite expects the parent directory to exist.
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const db = new PGlite(DATA_DIR);
      await initSchema(db);
      return db;
    })();
  }
  return dbPromise;
}

/**
 * Creates the messages table if it does not already exist.
 * @param {import('@electric-sql/pglite').PGlite} db
 */
async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      text        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/**
 * Fetch the full message history ordered chronologically.
 * @returns {Promise<Array<{id:number, text:string, created_at:string}>>}
 */
export async function getMessages() {
  const db = await getDb();
  const result = await db.query(
    'SELECT id, text, created_at FROM messages ORDER BY id ASC;'
  );
  return result.rows;
}

/**
 * Insert a new message and return the created row.
 * @param {string} text
 * @returns {Promise<{id:number, text:string, created_at:string}>}
 */
export async function insertMessage(text) {
  const db = await getDb();
  const result = await db.query(
    'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at;',
    [text]
  );
  return result.rows[0];
}
