import { PGlite } from "@electric-sql/pglite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Persist the PGLite database to the local filesystem so data survives restarts.
const DATA_DIR =
  process.env.PGLITE_DATA_DIR ||
  path.join(__dirname, "..", "data", "board");

let dbInstance = null;

/**
 * Initialise (once) the embedded PGLite database and ensure the schema exists.
 * Returns the shared PGlite instance.
 */
export async function initDb() {
  if (dbInstance) return dbInstance;

  const db = new PGlite(DATA_DIR);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      text        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  dbInstance = db;
  console.log(`[db] PGLite ready (data dir: ${DATA_DIR})`);
  return dbInstance;
}

export function getDb() {
  if (!dbInstance) {
    throw new Error("Database has not been initialised. Call initDb() first.");
  }
  return dbInstance;
}
