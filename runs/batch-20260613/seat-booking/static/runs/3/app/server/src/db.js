/**
 * Database module – initialises PGLite and exposes a single `query` helper
 * that serialises all SQL through a mutex so PGLite's single-writer model is
 * respected even under concurrent HTTP requests.
 *
 * The key design constraint: PGLite is single-writer – concurrent async
 * operations must not overlap.  We achieve this by chaining every operation
 * onto a single promise so they execute one at a time.  Errors are caught and
 * re-thrown to the caller without breaking the chain.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data/pglite');

// ---------------------------------------------------------------------------
// PGLite instance
// ---------------------------------------------------------------------------

export const db = new PGlite(DATA_DIR);

// ---------------------------------------------------------------------------
// Serialising mutex
// ---------------------------------------------------------------------------

/**
 * The tail of the serialisation chain.  Always resolves (never rejects) so
 * that a failing operation does not block subsequent callers.
 */
let _tail = Promise.resolve();

/**
 * Enqueue `fn` onto the serialisation chain.
 *
 * - `_tail` is always kept as a never-rejecting promise so the chain stays
 *   alive even when individual operations fail.
 * - The returned promise resolves/rejects with `fn`'s result so callers get
 *   proper error propagation.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function enqueue(fn) {
  /** @type {(value: T) => void} */
  let resolve;
  /** @type {(reason: unknown) => void} */
  let reject;

  // The promise we return to the caller.
  const result = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  // Advance the tail: wait for the current tail, then run fn, then settle
  // `result`.  The new tail always resolves so the chain is never broken.
  _tail = _tail.then(() =>
    fn().then(
      (value) => { resolve(value); },
      (err)   => { reject(err); },
    ),
  );

  return result;
}

/**
 * Execute a SQL statement with optional parameters, serialised through the
 * global mutex so concurrent callers never overlap inside PGLite.
 *
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<import('@electric-sql/pglite').Results<any>>}
 */
export function query(sql, params = []) {
  return enqueue(() => db.query(sql, params));
}

/**
 * Run a callback inside a PGLite transaction, serialised through the mutex.
 * The callback receives the PGLite transaction object directly.
 *
 * @template T
 * @param {(tx: import('@electric-sql/pglite').Transaction) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function transaction(fn) {
  return enqueue(() => db.transaction(fn));
}
