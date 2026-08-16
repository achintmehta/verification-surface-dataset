/**
 * Database module – initialises PGLite and exposes a single `query` helper
 * that serialises all SQL through a promise queue so the single-connection
 * embedded engine is never called concurrently.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data/pglite');

// Ensure the data directory exists before PGLite tries to open it
mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Singleton PGLite instance
// ---------------------------------------------------------------------------

let _db = null;

export async function getDb() {
  if (_db) return _db;
  _db = new PGlite(DATA_DIR);
  // waitReady is a Promise that resolves when PGLite is fully initialised
  await _db.waitReady;
  return _db;
}

/**
 * Initialise the database connection eagerly (called at startup).
 * Subsequent calls to getDb() return the cached instance.
 */
export async function initDb() {
  return getDb();
}

// ---------------------------------------------------------------------------
// Serialised query queue
// Guarantees that no two SQL statements run concurrently on the same PGLite
// connection, which is required because PGLite is single-threaded and does
// not support concurrent queries.
// ---------------------------------------------------------------------------

let _queue = Promise.resolve();

/**
 * Run `fn(db)` serially – every call waits for the previous one to finish.
 * @template T
 * @param {(db: import('@electric-sql/pglite').PGlite) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function serialise(fn) {
  const next = _queue.then(async () => {
    const db = await getDb();
    return fn(db);
  });
  // Swallow errors on the shared chain so one failure doesn't block the queue
  _queue = next.catch(() => {});
  return next;
}

/**
 * Convenience wrapper: run a single parameterised query serially.
 * @param {string} sql
 * @param {unknown[]} [params]
 */
export function query(sql, params = []) {
  return serialise((db) => db.query(sql, params));
}

/**
 * Run multiple statements inside a single serialised transaction.
 * `fn` receives the db instance and must use it directly (not `query()`).
 * @template T
 * @param {(db: import('@electric-sql/pglite').PGlite) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function transaction(fn) {
  return serialise(async (db) => {
    await db.query('BEGIN');
    try {
      const result = await fn(db);
      await db.query('COMMIT');
      return result;
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  });
}
