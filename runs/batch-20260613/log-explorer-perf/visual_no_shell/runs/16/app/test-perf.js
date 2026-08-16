import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'server/pglite-data');

async function test() {
  const db = new PGlite(dbPath);
  await db.waitReady;
  
  console.time('offset 0');
  await db.query('SELECT * FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 0');
  console.timeEnd('offset 0');

  console.time('offset 50000');
  await db.query('SELECT * FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 50000');
  console.timeEnd('offset 50000');

  console.time('offset 99900');
  await db.query('SELECT * FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 99900');
  console.timeEnd('offset 99900');

  console.time('severity offset 90000');
  await db.query("SELECT * FROM logs WHERE severity = 'info' ORDER BY ts DESC LIMIT 100 OFFSET 20000");
  console.timeEnd('severity offset 90000');

  console.time('search offset 50000');
  await db.query("SELECT * FROM logs WHERE message ILIKE '%job%' ORDER BY ts DESC LIMIT 100 OFFSET 10000");
  console.timeEnd('search offset 50000');
}

test();
