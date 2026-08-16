const { PGlite } = require("@electric-sql/pglite");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "pgdata");

let db;

async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  // PGlite exposes waitReady as a promise; await it to ensure the DB is up
  if (db.waitReady) {
    await db.waitReady;
  }
  return db;
}

module.exports = { getDb };
