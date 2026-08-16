import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Persist to local disk so data survives server restarts.
const dataDir = join(__dirname, '..', 'data', 'pgdata');
mkdirSync(dataDir, { recursive: true });

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  const db = new PGlite(dataDir);
  await db.waitReady;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id        SERIAL PRIMARY KEY,
      title     TEXT NOT NULL,
      start_at  TIMESTAMPTZ NOT NULL,
      end_at    TIMESTAMPTZ NOT NULL,
      CONSTRAINT end_after_start CHECK (end_at > start_at)
    );
  `);
  dbInstance = db;
  return db;
}
