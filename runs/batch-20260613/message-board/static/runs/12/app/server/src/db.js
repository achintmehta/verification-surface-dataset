import { PGlite } from "@electric-sql/pglite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the embedded PGLite database to the local file system.
// The data directory lives alongside the server source so it survives restarts.
const DATA_DIR = process.env.PGLITE_DATA_DIR
  ? path.resolve(process.env.PGLITE_DATA_DIR)
  : path.resolve(__dirname, "..", "data", "pgdata");

let dbInstance = null;

/**
 * Lazily create (or return the existing) PGLite instance.
 * @returns {Promise<PGlite>}
 */
export async function getDb() {
  if (!dbInstance) {
    dbInstance = new PGlite(DATA_DIR);
    await dbInstance.waitReady;
  }
  return dbInstance;
}

/**
 * Ensure the `messages` table exists.
 */
export async function initDb() {
  const db = await getDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      text       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  return db;
}
