/**
 * Simple async mutex to serialize database transactions.
 * Since PGlite uses a single connection, concurrent BEGIN/COMMIT
 * from interleaved async handlers would corrupt transaction state.
 * This lock ensures only one transaction runs at a time.
 */
class AsyncMutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  async acquire() {
    return new Promise(resolve => {
      if (!this._locked) {
        this._locked = true;
        resolve();
      } else {
        this._queue.push(resolve);
      }
    });
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }

  /**
   * Execute fn while holding the lock.
   */
  async withLock(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const dbLock = new AsyncMutex();

module.exports = { dbLock };
