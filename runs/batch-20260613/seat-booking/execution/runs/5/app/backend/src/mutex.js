/**
 * Simple async mutex to serialise write operations against PGLite.
 *
 * PGLite is an embedded single-writer database; concurrent async writes
 * can interleave and corrupt state.  All mutating routes acquire this
 * mutex before touching the database.
 */

let queue = Promise.resolve();

/**
 * Acquire the mutex, run `fn`, then release.
 * Returns whatever `fn` returns (or re-throws its error).
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withLock(fn) {
  // Chain onto the existing queue so writes are serialised FIFO.
  const next = queue.then(() => fn());
  // The public queue must never reject (otherwise all subsequent
  // callers would also reject).  We swallow the error here and let
  // it propagate only to the original caller via `next`.
  queue = next.catch(() => {});
  return next;
}
