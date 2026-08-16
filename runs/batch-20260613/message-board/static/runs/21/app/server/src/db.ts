import { PGlite } from "@electric-sql/pglite";
import path from "node:path";

const DB_PATH = path.resolve(process.cwd(), "..", "data", "message-board-db");

let db: PGlite | null = null;

/**
 * Returns the singleton PGlite instance, creating it on first call.
 * The database is persisted to `<project-root>/data/message-board-db`.
 */
export async function getDb(): Promise<PGlite> {
  if (db) {
    return db;
  }

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

/**
 * Represents a single message row returned from the database.
 */
export interface MessageRow {
  id: number;
  text: string;
  created_at: string;
}
