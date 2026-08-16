'use strict';

const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

// Persist PGLite to the local filesystem so data survives restarts.
const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, 'pgdata');

let dbInstance = null;

async function getDb() {
  if (dbInstance) return dbInstance;

  const db = new PGlite(DATA_DIR);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT end_after_start CHECK (end_at > start_at)
    );
  `);

  dbInstance = db;
  return dbInstance;
}

module.exports = { getDb, DATA_DIR };
