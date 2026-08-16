// A tiny FIFO mutex. PGlite is a single embedded instance that does not provide
// concurrent multi-statement transaction isolation between interleaved async
// callers, so we serialize all write operations (hold/confirm/release/sweep)
// through this lock. This guarantees the atomic check-and-set semantics the
// booking system requires.

let chain = Promise.resolve();

export function withLock(fn) {
  const run = chain.then(() => fn());
  // Keep the chain going regardless of success/failure of fn.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
