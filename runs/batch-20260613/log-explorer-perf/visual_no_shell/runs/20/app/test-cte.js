const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function test() {
  const db = new PGlite(path.join(__dirname, 'pglite-data'));
  await db.waitReady;
  
  console.time('CTE scan');
  await db.query(`
    WITH filtered AS (
      SELECT id, ts, severity, service, message
      FROM logs
      WHERE message ILIKE '%nonexistent%'
    )
    SELECT * FROM filtered ORDER BY ts DESC LIMIT 100 OFFSET 50000;
  `);
  console.timeEnd('CTE scan');
  
  console.time('CTE scan with materialized');
  await db.query(`
    WITH filtered AS MATERIALIZED (
      SELECT id, ts, severity, service, message
      FROM logs
      WHERE message ILIKE '%nonexistent%'
    )
    SELECT * FROM filtered ORDER BY ts DESC LIMIT 100 OFFSET 50000;
  `);
  console.timeEnd('CTE scan with materialized');
}

test().catch(console.error);