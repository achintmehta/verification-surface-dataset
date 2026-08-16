// Application-level mutex for serializing database mutations.
// PGLite is single-connection embedded, so we can't rely on
// row-level locks (FOR UPDATE). Instead, we serialize all
// mutating operations through this lock.

let mutexPromise = Promise.resolve();

export function withLock(fn) {
  const prev = mutexPromise;
  let resolve;
  mutexPromise = new Promise(r => { resolve = r; });
  return prev.then(() => fn().finally(resolve));
}
