const { PGlite } = require("@electric-sql/pglite");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "pgdata");

let db;

async function getDb() {
  if (db) return db;

  db = new PGlite(DB_PATH);

  // Create the messages table if it doesn't exist
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  console.log("PGLite database initialized at", DB_PATH);
  return db;
}

module.exports = { getDb };
