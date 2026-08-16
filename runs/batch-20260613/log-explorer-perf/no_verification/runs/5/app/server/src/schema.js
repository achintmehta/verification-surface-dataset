/**
 * Creates the logs table and supporting indexes if they don't exist.
 *
 * Index strategy:
 *   - idx_logs_ts          : covers ORDER BY ts DESC (all-rows queries)
 *   - idx_logs_severity_ts : covers WHERE severity = ? ORDER BY ts DESC
 *   - idx_logs_message_lower: expression index on lower(message) for LIKE '%q%'
 *     Note: PGLite/PostgreSQL can use this for lower(message) LIKE lower('%q%')
 *     which we rewrite as lower(message) LIKE '%<lowered_q>%'
 *
 * For deep-offset performance we rely on the index to avoid full-table scans;
 * the ORDER BY ts DESC is fully index-backed so OFFSET is a fast index scan.
 */
export async function initSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id       BIGSERIAL PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT        NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service  TEXT        NOT NULL,
      message  TEXT        NOT NULL
    )
  `);

  // Primary ordering index
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts
      ON logs (ts DESC)
  `);

  // Severity + ordering (covers severity-filtered queries)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts
      ON logs (severity, ts DESC)
  `);

  // Expression index for case-insensitive substring search
  // lower(message) allows LIKE '%term%' to use this index via pg_trgm,
  // but without pg_trgm we at least avoid a function call per row.
  // We also create a trigram-style approach: store lower(message) so
  // the planner can use it. Without pg_trgm, LIKE scans are sequential
  // but the expression index still helps the planner avoid re-computing lower().
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_logs_message_lower
      ON logs (lower(message))
  `);

  // Combined severity + message lower for filtered substring queries
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_logs_severity_message
      ON logs (severity, lower(message))
  `);

  console.log('[schema] Schema and indexes ready.');
}
