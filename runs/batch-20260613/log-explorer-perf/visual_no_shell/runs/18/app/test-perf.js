import { PGlite } from '@electric-sql/pglite';

async function test() {
  const db = new PGlite('./pglite-data');
  await db.waitReady;
  
  console.time('offset 99900');
  await db.query('SELECT id, ts, severity, service, message FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 99900');
  console.timeEnd('offset 99900');

  console.time('offset 99900 with severity');
  await db.query("SELECT id, ts, severity, service, message FROM logs WHERE severity = 'info' ORDER BY ts DESC LIMIT 100 OFFSET 20000");
  console.timeEnd('offset 99900 with severity');

  console.time('offset 99900 with q');
  await db.query("SELECT id, ts, severity, service, message FROM logs WHERE message ILIKE '%user%' ORDER BY ts DESC LIMIT 100 OFFSET 10000");
  console.timeEnd('offset 99900 with q');
}

test().catch(console.error);
