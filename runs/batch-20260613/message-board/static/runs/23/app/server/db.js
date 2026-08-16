import { PGlite } from "@electric-sql/pglite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "pgdata");

/** @type {PGlite | null} */
let db = null;

/**
 * Initialise (or return the existing) PGLite instance.
 * The database is persisted to the local filesystem under `./pgdata`.
 *
 * @returns {Promise<PGlite>}
 */
export async function getDb() {
  if (db) return db;

  db = new PGlite(DATA_DIR);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      text       TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  return db;
}
