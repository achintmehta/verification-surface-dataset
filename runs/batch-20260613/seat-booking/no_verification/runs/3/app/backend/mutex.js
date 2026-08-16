/**
 * Simple async mutex to serialize access to PGLite.
 *
 * PGLite is a single-connection embedded database. While Node.js is
 * single-threaded, async operations can interleave: two concurrent requests
 * could both issue BEGIN before either issues COMMIT, corrupting transaction
 * state. This mutex ensures only one transaction runs at a time.
 */

export class Mutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  /**
   * Acquire the lock, run fn(), then release.
   * Returns the result of fn().
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

export const dbMutex = new Mutex();
