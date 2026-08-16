// A minimal in-process async mutex.
//
// PGLite runs inside this single Node.js process on one logical connection.
// While PGLite serializes individual queries, a check-and-set sequence that
// spans multiple awaited statements (read seat states, then conditionally
// update them) could otherwise interleave with another request between the
// awaits. Holding this mutex around each such critical section guarantees
// that hold/confirm/release/expiry operations execute one-at-a-time, which is
// what makes "exactly one concurrent request wins a seat" hold true.
//
// This is appropriate because the entire booking system is a single-process
// server backed by embedded PGLite; there is no second writer to coordinate
// with. We still use real SQL transactions inside the critical sections so
// that any failure rolls back cleanly.

let queue = Promise.resolve();

export function withLock(fn) {
  // Chain onto the existing queue so callers run strictly in order.
  const run = queue.then(() => fn());
  // Ensure a rejection in one critical section does not poison the queue.
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
