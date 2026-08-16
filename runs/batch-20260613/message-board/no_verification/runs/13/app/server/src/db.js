import { PGlite } from "@electric-sql/pglite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist PGLite data to the local file system. The directory is created
// automatically by PGLite if it does not already exist.
const DATA_DIR = process.env.PGLITE_DATA_DIR
  ? path.resolve(process.env.PGLITE_DATA_DIR)
  : path.resolve(__dirname, "..", "pgdata");

// A single shared PGLite instance tied to this Node process.
export const db = new PGlite(DATA_DIR);

/**
 * Initialize the database schema. Creates the `messages` table if it does
 * not already exist. Safe to call multiple times.
 */
export async function initDb() {
  await db.waitReady;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      text        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log(`[db] PGLite initialized (data dir: ${DATA_DIR})`);
}

/**
 * Fetch all messages ordered chronologically (oldest first).
 */
export async function getMessages() {
  const result = await db.query(
    "SELECT id, text, created_at FROM messages ORDER BY id ASC;"
  );
  return result.rows;
}

/**
 * Insert a new message and return the created row.
 * @param {string} text
 */
export async function insertMessage(text) {
  const result = await db.query(
    "INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at;",
    [text]
  );
  return result.rows[0];
}
