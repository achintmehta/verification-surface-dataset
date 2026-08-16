/**
 * Creates the logs table and supporting indexes.
 *
 * Index strategy:
 *   1. idx_logs_ts_covering     — covering index on ts DESC, includes all columns
 *                                  → used for ORDER BY ts DESC (no filter), index-only scan
 *   2. idx_logs_severity_ts     — index on (severity, ts DESC)
 *                                  → used for WHERE severity = ? ORDER BY ts DESC
 *   3. idx_logs_message_trgm    — GIN trigram index for ILIKE substring search
 *
 * The covering ts index avoids heap fetches for no-filter queries.
 * The severity index allows the planner to use an index scan that only
 * reads rows matching the severity, avoiding scanning all rows.
 *
 * PGLite supports pg_trgm via the contrib extension (must be loaded at init).
 */
export async function initSchema(db) {
  // Enable trigram extension for fast ILIKE
  await db.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id        BIGSERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT        NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service   TEXT        NOT NULL,
      message   TEXT        NOT NULL
    )
  `);

  // Covering index for ORDER BY ts DESC (no filter) — enables index-only scans
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts_covering
      ON logs (ts DESC)
      INCLUDE (id, severity, service, message)
  `);

  // Index for WHERE severity = ? ORDER BY ts DESC
  // The planner uses this when a severity filter is present, reading only
  // matching rows in ts order — much faster than scanning all rows.
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts
      ON logs (severity, ts DESC)
  `);

  // GIN trigram index for fast ILIKE on message
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
      ON logs USING GIN (message gin_trgm_ops)
  `);

  console.log('[schema] Schema and indexes ready.');
}

/**
 * Run VACUUM ANALYZE after seeding to:
 * 1. Update statistics for the query planner
 * 2. Set the visibility map so index-only scans don't need heap fetches
 */
export async function vacuumAnalyze(db) {
  console.log('[schema] Running VACUUM ANALYZE...');
  await db.query('VACUUM ANALYZE logs');
  console.log('[schema] VACUUM ANALYZE complete.');
}
