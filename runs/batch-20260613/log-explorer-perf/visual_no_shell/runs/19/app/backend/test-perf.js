import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const db = new PGlite('./pglite-data');

async function test() {
  await db.waitReady;
  
  let out = '';
  
  for (let i = 0; i < 5; i++) {
    const start1 = Date.now();
    await db.query(`SELECT COUNT(*) FROM logs WHERE message ILIKE '%user%'`);
    out += `count: ${Date.now() - start1}ms\n`;
    
    const start2 = Date.now();
    await db.query(`SELECT * FROM logs WHERE message ILIKE '%pay_123%' ORDER BY ts DESC LIMIT 100 OFFSET 50000`);
    out += `selective: ${Date.now() - start2}ms\n`;
    
    const start3 = Date.now();
    await db.query(`SELECT * FROM logs WHERE message ILIKE '%user%' ORDER BY ts DESC LIMIT 100 OFFSET 50000`);
    out += `non-selective: ${Date.now() - start3}ms\n`;
  }
  
  fs.writeFileSync('perf-out.txt', out);
}

test();