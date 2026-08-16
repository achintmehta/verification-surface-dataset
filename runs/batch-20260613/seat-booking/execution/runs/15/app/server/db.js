import { PGlite } from '@electric-sql/pglite';
import { ROWS, SEATS_PER_ROW, DB_DIR } from './config.js';

let db;

/**
 * A single shared PGlite instance. PGlite serializes statements onto a single
 * connection, but to guarantee atomicity of multi-statement units we also
 * funnel every transaction through an in-process async mutex (see withTxn).
 */
export async function getDb() {
  if (!db) {
    db = new PGlite(DB_DIR);
    await db.waitReady;
    await initSchema(db);
  }
  return db;
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id              TEXT PRIMARY KEY,
      row_label       TEXT NOT NULL,
      seat_number     INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available','held','booked')),
      hold_id         TEXT,
      hold_expires_at BIGINT,
      booked_by       TEXT
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      created_at  BIGINT NOT NULL,
      expires_at  BIGINT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','confirmed','released','expired'))
    );
  `);

  // Seed the fixed seat map only once.
  const { rows } = await db.query(`SELECT COUNT(*)::int AS c FROM seats`);
  if (rows[0].c === 0) {
    await seedSeats(db);
  }
}

async function seedSeats(db) {
  const values = [];
  const params = [];
  let i = 1;
  for (let r = 0; r < ROWS; r++) {
    const rowLabel = String.fromCharCode(65 + r); // A, B, C ...
    for (let s = 1; s <= SEATS_PER_ROW; s++) {
      const id = `${rowLabel}${s}`;
      values.push(`($${i++}, $${i++}, $${i++})`);
      params.push(id, rowLabel, s);
    }
  }
  await db.query(
    `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(',')}`,
    params
  );
}

// ---------------------------------------------------------------------------
// In-process serialization of write transactions.
//
// PGlite is a single embedded instance with no real concurrent connections,
// but Node handles many requests interleaved on the event loop. To make each
// hold/confirm/release/expiry a truly atomic check-and-set we run them inside
// a BEGIN/COMMIT *and* serialize them with a promise-chain mutex so two
// transactions never interleave their statements.
// ---------------------------------------------------------------------------
let chain = Promise.resolve();

export function withTxn(fn) {
  const run = chain.then(async () => {
    const db = await getDb();
    await db.exec('BEGIN');
    try {
      const result = await fn(db);
      await db.exec('COMMIT');
      return result;
    } catch (err) {
      try { await db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
      throw err;
    }
  });
  // Keep the chain alive even if this txn rejects.
  chain = run.then(() => {}, () => {});
  return run;
}
