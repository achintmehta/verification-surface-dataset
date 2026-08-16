/**
 * Database module: initialises PGLite and creates the events table.
 * PGLite persists to the local filesystem at ./data/pglite
 */

import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data/pglite');

// Ensure the data directory exists before PGLite tries to open it.
fs.mkdirSync(DATA_DIR, { recursive: true });

let _db = null;

/**
 * Returns the singleton PGLite instance, initialising it on first call.
 * @returns {Promise<PGlite>}
 */
export async function getDb() {
  if (_db) return _db;

  _db = new PGlite(DATA_DIR);

  // Wait for PGLite to be ready before running DDL.
  await _db.waitReady;

  await _db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id        SERIAL PRIMARY KEY,
      title     TEXT        NOT NULL CHECK (title <> ''),
      start_at  TIMESTAMP   NOT NULL,
      end_at    TIMESTAMP   NOT NULL,
      CHECK (end_at > start_at)
    );

    CREATE INDEX IF NOT EXISTS events_start_at_idx ON events (start_at);
    CREATE INDEX IF NOT EXISTS events_end_at_idx   ON events (end_at);
  `);

  return _db;
}
