import { PGlite } from "@electric-sql/pglite";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "pgdata");

let db;

/**
 * Initialise the embedded PGLite database.
 * Data is persisted to the ./pgdata directory on the local filesystem.
 */
export async function initDB() {
  db = new PGlite(DATA_DIR);

  // Create the messages table if it doesn't already exist.
  await db.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      text       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log(`PGLite initialised – data directory: ${DATA_DIR}`);
  return db;
}

/**
 * Return the initialised database instance.
 */
export function getDB() {
  if (!db) {
    throw new Error("Database has not been initialised. Call initDB() first.");
  }
  return db;
}
