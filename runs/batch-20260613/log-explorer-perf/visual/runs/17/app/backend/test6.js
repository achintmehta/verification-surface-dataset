const { PGlite } = require('@electric-sql/pglite');
async function test() {
  const db = new PGlite('./test-db');
  await db.waitReady;
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_fts ON logs USING GIN (to_tsvector('simple', message));`);
  console.time('fts');
  await db.query(`SELECT *, COUNT(*) OVER() as total_count FROM logs WHERE to_tsvector('simple', message) @@ to_tsquery('simple', '99999') ORDER BY ts DESC LIMIT 100 OFFSET 0`);
  console.timeEnd('fts');
}
test();