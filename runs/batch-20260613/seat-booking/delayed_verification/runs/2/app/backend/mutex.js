/**
 * mutex.js – A simple async mutual-exclusion lock.
 *
 * PGLite is single-connection embedded SQLite-style; concurrent JS async
 * operations can interleave their awaits and corrupt multi-step transactions.
 * We serialise all DB-mutating operations through this mutex so that each
 * hold / confirm / release is fully atomic from the perspective of the JS
 * event loop, complementing the SQL-level constraints.
 */

export class Mutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  /**
   * Acquire the lock, run `fn`, then release.
   * Returns whatever `fn` returns (or re-throws its error).
   */
  async run(fn) {
    await this._acquire();
    try {
      return await fn();
    } finally {
      this._release();
    }
  }

  _acquire() {
    if (!this._locked) {
      this._locked = true;
      return Promise.resolve();
    }
    return new Promise(resolve => this._queue.push(resolve));
  }

  _release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }
}

// Singleton used by all route handlers.
export const dbMutex = new Mutex();
