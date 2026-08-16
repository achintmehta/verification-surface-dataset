import { PGlite } from '@electric-sql/pglite';
import { ROWS, SEATS_PER_ROW, DB_DIR } from './config.js';

let db = null;

// Serialize all write operations through a single in-process promise chain.
// PGlite runs in-process and is single-connection; chaining transactions this
// way guarantees that our atomic seat-acquisition transactions never interleave
// with one another, which is the foundation of correctness under concurrency.
let opChain = Promise.resolve();

/**
 * Run `fn` exclusively: no other queued operation runs concurrently.
 * Returns a promise resolving to fn's result.
 */
export function withLock(fn) {
  const run = opChain.then(() => fn());
  // Keep the chain alive even if fn rejects, but don't swallow the error for the caller.
  opChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

function rowLabel(index) {
  // 0 -> 'A', 1 -> 'B', ...
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

export async function initDb() {
  db = new PGlite(DB_DIR);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id              TEXT PRIMARY KEY,
      row_label       TEXT NOT NULL,
      seat_number     INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available','held','booked')),
      hold_id         TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by       TEXT
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','confirmed','released','expired'))
    );
  `);

  // Seed the fixed seat map only if empty.
  const countRes = await db.query('SELECT COUNT(*)::int AS n FROM seats;');
  const existing = countRes.rows[0].n;
  if (existing === 0) {
    await db.transaction(async (tx) => {
      for (let r = 0; r < ROWS; r++) {
        const label = rowLabel(r);
        for (let s = 1; s <= SEATS_PER_ROW; s++) {
          const id = `${label}${s}`;
          await tx.query(
            `INSERT INTO seats (id, row_label, seat_number, status)
             VALUES ($1, $2, $3, 'available');`,
            [id, label, s]
          );
        }
      }
    });
  }

  return db;
}
