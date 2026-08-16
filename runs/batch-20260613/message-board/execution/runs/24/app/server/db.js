import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "message-board");

// Ensure the parent directory exists before PGLite tries to create its own
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db;

export async function getDb() {
  if (db) return db;

  db = new PGlite(DB_PATH);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log("[db] PGLite initialized and messages table ready");
  return db;
}
