const { PGlite } = require('@electric-sql/pglite');
const { pg_trgm } = require('@electric-sql/pglite/contrib/pg_trgm');
const path = require('path');

async function test() {
  const db = new PGlite(path.join(__dirname, 'pglite-data'), {
    extensions: { pg_trgm }
  });
  await db.waitReady;
  
  await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
  console.log('pg_trgm created successfully');
  
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);');
  console.log('Index created successfully');
  
  console.time('Normal scan (selective)');
  await db.query(`
    SELECT id, ts, severity, service, message
    FROM logs
    WHERE message ILIKE '%nonexistent%'
    ORDER BY ts DESC LIMIT 100 OFFSET 50000;
  `);
  console.timeEnd('Normal scan (selective)');
}

test().catch(console.error);