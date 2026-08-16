import { PGlite } from "@electric-sql/pglite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "pgdata");

let db;

/**
 * Initialise (or re-use) the embedded PGLite instance.
 * Data is persisted to the `pgdata/` directory at the project root.
 */
export async function getDb() {
  if (db) return db;

  db = new PGlite(DB_PATH);

  // Create the messages table if it doesn't already exist.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      text       TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  return db;
}
