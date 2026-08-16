const { PGlite } = require('@electric-sql/pglite');
async function test() {
  const db = new PGlite('./test-db');
  await db.waitReady;
  const res = await db.query(`SELECT message FROM logs WHERE to_tsvector('simple', message) @@ to_tsquery('simple', 'ser_12') LIMIT 1`);
  console.log(res.rows);
}
test();