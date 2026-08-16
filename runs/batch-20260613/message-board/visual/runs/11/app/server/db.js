import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the embedded PostgreSQL database to the local filesystem.
// PGLite stores the database as a directory of files; this keeps data
// across server restarts without needing an external Postgres service.
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'data', 'pgdata');

let dbPromise;

/**
 * Lazily create (and memoize) the PGLite instance and ensure the schema
 * exists. Returns the ready-to-use PGlite database handle.
 */
export async function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      // PGLite does not create intermediate directories, so ensure the
      // parent path exists before opening the database.
      fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });
      const db = new PGlite(DATA_DIR);
      await db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id         SERIAL PRIMARY KEY,
          text       TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      return db;
    })();
  }
  return dbPromise;
}

/**
 * Fetch the historical messages in chronological order (oldest first).
 */
export async function getMessages(limit = 500) {
  const db = await getDb();
  const result = await db.query(
    `SELECT id, text, created_at
       FROM messages
       ORDER BY id ASC
       LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Insert a new message and return the freshly created row.
 */
export async function insertMessage(text) {
  const db = await getDb();
  const result = await db.query(
    `INSERT INTO messages (text)
        VALUES ($1)
     RETURNING id, text, created_at`,
    [text]
  );
  return result.rows[0];
}
