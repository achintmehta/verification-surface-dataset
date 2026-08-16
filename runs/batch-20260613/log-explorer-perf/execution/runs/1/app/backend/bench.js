import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, 'data', 'pglite');

const db = new PGlite(DB_DIR);
await db.waitReady;

console.log('DB ready, running benchmarks...\n');

const queries = [
  ['severity=debug offset=50000', 'SELECT id, ts, severity, service, message FROM logs WHERE severity = $1 ORDER BY ts DESC LIMIT 100 OFFSET 50000', ['debug']],
  ['severity=debug COUNT', 'SELECT COUNT(*) FROM logs WHERE severity = $1', ['debug']],
  ['q=user offset=50000', 'SELECT id, ts, severity, service, message FROM logs WHERE message ILIKE $1 ORDER BY ts DESC LIMIT 100 OFFSET 50000', ['%user%']],
  ['no filter offset=99900', 'SELECT id, ts, severity, service, message FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 99900', []],
  ['EXPLAIN severity=debug offset=50000', 'EXPLAIN SELECT id, ts, severity, service, message FROM logs WHERE severity = $1 ORDER BY ts DESC LIMIT 100 OFFSET 50000', ['debug']],
];

for (const [name, sql, params] of queries) {
  // Warm up
  await db.query(sql, params);
  
  const times = [];
  for (let i = 0; i < 10; i++) {
    const start = Date.now();
    const result = await db.query(sql, params);
    const elapsed = Date.now() - start;
    times.push(elapsed);
    if (name.startsWith('EXPLAIN')) {
      console.log(`${name}:`);
      for (const row of result.rows) {
        console.log(' ', Object.values(row)[0]);
      }
    }
  }
  times.sort((a, b) => a - b);
  const p50 = times[5];
  const p95 = times[9];
  console.log(`${name}: p50=${p50}ms p95=${p95}ms min=${times[0]}ms max=${times[9]}ms`);
}

process.exit(0);
