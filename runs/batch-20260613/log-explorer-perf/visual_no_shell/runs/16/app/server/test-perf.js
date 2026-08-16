import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'pglite-data');

async function test() {
  const db = new PGlite(dbPath);
  await db.waitReady;
  
  console.time('count all');
  await db.query('SELECT COUNT(*) FROM logs');
  console.timeEnd('count all');

  console.time('count severity');
  await db.query("SELECT COUNT(*) FROM logs WHERE severity = 'info'");
  console.timeEnd('count severity');

  console.time('count search');
  await db.query("SELECT COUNT(*) FROM logs WHERE message ILIKE '%job%'");
  console.timeEnd('count search');
  await db.query('SELECT * FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 0');
  console.timeEnd('offset 0');

  console.time('offset 50000');
  await db.query('SELECT * FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 50000');
  console.timeEnd('offset 50000');

  console.time('offset 50000 join');
  await db.query('SELECT l.* FROM (SELECT id FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 50000) sub JOIN logs l ON l.id = sub.id ORDER BY l.ts DESC');
  console.timeEnd('offset 50000 join');

  console.time('offset 99900');
  await db.query('SELECT * FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 99900');
  console.timeEnd('offset 99900');

  console.time('severity offset 90000');
  await db.query("SELECT * FROM logs WHERE severity = 'info' ORDER BY ts DESC LIMIT 100 OFFSET 20000");
  console.timeEnd('severity offset 90000');

  console.time('severity offset 90000 join');
  await db.query("SELECT l.* FROM (SELECT id FROM logs WHERE severity = 'info' ORDER BY ts DESC LIMIT 100 OFFSET 20000) sub JOIN logs l ON l.id = sub.id ORDER BY l.ts DESC");
  console.timeEnd('severity offset 90000 join');

  console.time('search offset 50000');
  await db.query("SELECT * FROM logs WHERE message ILIKE '%job%' ORDER BY ts DESC LIMIT 100 OFFSET 10000");
  console.timeEnd('search offset 50000');

  console.time('search offset 50000 join');
  await db.query("SELECT l.* FROM (SELECT id FROM logs WHERE message ILIKE '%job%' ORDER BY ts DESC LIMIT 100 OFFSET 10000) sub JOIN logs l ON l.id = sub.id ORDER BY l.ts DESC");
  console.timeEnd('search offset 50000 join');
}

test();
