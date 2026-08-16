// PGLite database adapter.
//
// PGLite already exposes query(), exec() and transaction(). We wrap it so the
// booking module sees a stable, minimal interface and so that we can serialize
// all access through a single connection (PGLite is single-connection, so a
// simple async mutex prevents interleaved transactions from corrupting state).

import { PGlite } from '@electric-sql/pglite';

export async function createDb(dataDir) {
  const pg = await PGlite.create(dataDir);

  // PGLite runs one statement at a time on a single connection. To guarantee
  // that a multi-statement transaction is not interleaved with other queries,
  // we serialize every database operation through a promise chain (mutex).
  let tail = Promise.resolve();
  function runExclusive(fn) {
    const result = tail.then(fn, fn);
    // Keep the chain alive regardless of success/failure, but don't let a
    // rejection poison the tail.
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  return {
    raw: pg,

    query(sql, params) {
      return runExclusive(() => pg.query(sql, params));
    },

    exec(sql) {
      return runExclusive(() => pg.exec(sql));
    },

    // Run the callback inside a single SQL transaction, exclusively.
    transaction(callback) {
      return runExclusive(async () => {
        await pg.query('BEGIN');
        try {
          const tx = {
            query: (sql, params) => pg.query(sql, params),
            exec: (sql) => pg.exec(sql),
          };
          const out = await callback(tx);
          await pg.query('COMMIT');
          return out;
        } catch (err) {
          try {
            await pg.query('ROLLBACK');
          } catch {
            // ignore rollback failures
          }
          throw err;
        }
      });
    },

    async close() {
      await pg.close();
    },
  };
}
