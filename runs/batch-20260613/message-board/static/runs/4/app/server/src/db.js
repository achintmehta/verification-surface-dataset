/**
 * db.js – Initialises an embedded PGLite instance that persists data to the
 * local filesystem under ./data/pglite (relative to the server working dir).
 *
 * We export a single `db` promise so callers can `await db` to get the ready
 * PGLite instance, and a convenience `query` helper that awaits it for them.
 */

import { PGlite } from "@electric-sql/pglite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the database files next to the server source, one level up.
const DATA_DIR = path.resolve(__dirname, "..", "data", "pglite");

console.log(`[db] PGLite data directory: ${DATA_DIR}`);

/**
 * A promise that resolves to the initialised PGLite instance.
 * Callers should `await getDb()` before issuing queries.
 */
let _db = null;

export async function getDb() {
  if (_db) return _db;

  const client = new PGlite(DATA_DIR);

  // Run schema migrations / initial setup.
  await client.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      text       TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log("[db] Schema ready.");
  _db = client;
  return _db;
}
