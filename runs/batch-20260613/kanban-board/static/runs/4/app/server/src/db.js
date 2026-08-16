/**
 * Database layer – PGLite embedded PostgreSQL persisted to ./data/kanban.db
 *
 * Exports:
 *   db          – the raw PGLite instance (for ad-hoc queries)
 *   initDb()    – run schema migrations + seed default columns
 *   query()     – thin wrapper that returns { rows }
 *   transaction() – run a callback inside BEGIN/COMMIT, auto-ROLLBACK on error
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');

// PGLite accepts a filesystem path for durable storage.
export const db = new PGlite(`${DATA_DIR}/kanban.db`);

/**
 * Thin query wrapper – always returns { rows: [...] }
 * @param {string} sql
 * @param {any[]} [params]
 */
export async function query(sql, params = []) {
  const result = await db.query(sql, params);
  return result;
}

/**
 * Execute `fn(tx)` inside a serialised transaction using PGLite's native
 * transaction API.  `fn` receives a transaction-scoped query function.
 * PGLite automatically rolls back on any thrown error.
 *
 * @param {(tx: typeof query) => Promise<any>} fn
 */
export async function transaction(fn) {
  return db.transaction(async (tx) => {
    // Wrap tx.query so callers use the same (sql, params) signature as query()
    const txQuery = (sql, params = []) => tx.query(sql, params);
    return fn(txQuery);
  });
}

/**
 * Create schema and seed default columns if they don't exist yet.
 */
export async function initDb() {
  // Wait for PGLite to be ready
  await db.waitReady;

  await db.query(`
    CREATE TABLE IF NOT EXISTS columns (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cards (
      id         TEXT PRIMARY KEY,
      column_id  TEXT NOT NULL REFERENCES columns(id),
      text       TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Create indexes for common query patterns
  await db.query(`
    CREATE INDEX IF NOT EXISTS cards_column_position
      ON cards (column_id, position)
  `);

  // Seed default columns only when the table is empty
  const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM columns');
  const count = parseInt(rows[0].cnt, 10);

  if (count === 0) {
    const defaults = [
      { id: 'col-todo',        title: 'To Do',       position: 1000 },
      { id: 'col-inprogress',  title: 'In Progress', position: 2000 },
      { id: 'col-done',        title: 'Done',        position: 3000 },
    ];
    for (const col of defaults) {
      await db.query(
        'INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)',
        [col.id, col.title, col.position],
      );
    }
    console.log('[db] Seeded default columns.');
  }

  console.log('[db] Database ready.');
}
