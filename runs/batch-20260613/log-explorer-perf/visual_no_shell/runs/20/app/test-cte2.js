const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function test() {
  const db = new PGlite(path.join(__dirname, 'pglite-data'));
  await db.waitReady;
  
  console.time('CTE scan with materialized (non-selective)');
  await db.query(`
    WITH filtered AS MATERIALIZED (
      SELECT id, ts, severity, service, message
      FROM logs
      WHERE message ILIKE '%user%'
    )
    SELECT * FROM filtered ORDER BY ts DESC LIMIT 100 OFFSET 50000;
  `);
  console.timeEnd('CTE scan with materialized (non-selective)');
  
  console.time('Normal scan (non-selective)');
  await db.query(`
    SELECT id, ts, severity, service, message
    FROM logs
    WHERE message ILIKE '%user%'
    ORDER BY ts DESC LIMIT 100 OFFSET 50000;
  `);
  console.timeEnd('Normal scan (non-selective)');
}

test().catch(console.error);