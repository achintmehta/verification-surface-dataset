/**
 * mutex.js – A simple async mutex to serialize critical sections.
 *
 * PGLite is single-threaded (WASM) and serializes transactions internally,
 * but we add an application-level mutex around hold/confirm/release operations
 * to guarantee that no two concurrent requests can interleave their
 * check-then-act logic even across the async await boundaries.
 *
 * Usage:
 *   const release = await mutex.acquire();
 *   try { ... } finally { release(); }
 */

export class Mutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  acquire() {
    return new Promise((resolve) => {
      if (!this._locked) {
        this._locked = true;
        resolve(this._release.bind(this));
      } else {
        this._queue.push(resolve);
      }
    });
  }

  _release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next(this._release.bind(this));
    } else {
      this._locked = false;
    }
  }
}

// Singleton mutex for all seat-state mutations.
export const seatMutex = new Mutex();
