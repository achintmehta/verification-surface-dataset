const { PGlite } = require('@electric-sql/pglite');
async function test() {
  const db = new PGlite('./test-db');
  await db.waitReady;
  await db.exec('CREATE TABLE test (id int);');
  console.log('success');
}
test();