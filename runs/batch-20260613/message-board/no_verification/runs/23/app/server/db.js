import { PGlite } from "@electric-sql/pglite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(__dirname, "..", "data", "pglite");

let db;

/**
 * Returns the singleton PGLite instance, creating it on first call.
 * The database is persisted to disk at DATA_DIR.
 */
export async function getDb() {
  if (!db) {
    db = new PGlite(DATA_DIR);
    await db.waitReady;
    await migrate(db);
  }
  return db;
}

/**
 * Allows injecting an in-memory PGLite instance for tests.
 */
export async function setDb(instance) {
  db = instance;
  await migrate(db);
}

/**
 * Run database migrations – idempotent.
 */
async function migrate(database) {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      text       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

/**
 * Insert a new message and return the created row.
 */
export async function insertMessage(text) {
  const database = db || (await getDb());
  const result = await database.query(
    "INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at",
    [text]
  );
  return result.rows[0];
}

/**
 * Fetch all messages ordered by creation time ascending.
 */
export async function getMessages() {
  const database = db || (await getDb());
  const result = await database.query(
    "SELECT id, text, created_at FROM messages ORDER BY created_at ASC"
  );
  return result.rows;
}
