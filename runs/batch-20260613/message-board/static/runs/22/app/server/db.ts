import { PGlite } from "@electric-sql/pglite";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), "pgdata");

let db: PGlite | null = null;

/**
 * Returns the singleton PGlite instance, creating it on first call.
 * Data is persisted to the `pgdata/` directory on disk.
 */
export async function getDB(): Promise<PGlite> {
  if (db) {
    return db;
  }

  db = new PGlite(DATA_DIR);
  await db.waitReady;
  await runMigrations(db);
  return db;
}

/**
 * Creates the `messages` table if it does not already exist.
 */
async function runMigrations(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      text       TEXT        NOT NULL CHECK (char_length(text) > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  console.log("[db] migrations complete – messages table ready");
}
