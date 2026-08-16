import { PGlite } from "@electric-sql/pglite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "pgdata");

let db;

export async function getDb() {
  if (db) return db;

  db = new PGlite(DB_PATH);
  await db.waitReady;

  // Create the messages table if it doesn't exist
  await db.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  console.log("PGLite database initialized at", DB_PATH);
  return db;
}
