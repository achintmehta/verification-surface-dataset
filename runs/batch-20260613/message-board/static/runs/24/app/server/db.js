import { PGlite } from "@electric-sql/pglite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "message-board");

/** @type {PGlite | null} */
let db = null;

/**
 * Initialise the embedded PGLite database, creating the `messages` table if it
 * does not already exist. Returns the singleton PGLite instance.
 *
 * @returns {Promise<PGlite>}
 */
export async function getDb() {
  if (db) return db;

  db = new PGlite(DB_PATH);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      text       TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  return db;
}
