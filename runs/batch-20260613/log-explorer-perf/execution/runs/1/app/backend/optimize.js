/**
 * Run ANALYZE and check/fix indexes for optimal query performance.
 */
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, 'data', 'pglite');

const db = new PGlite(DB_DIR);
await db.waitReady;

console.log('Running ANALYZE...');
await db.exec('ANALYZE logs;');
console.log('ANALYZE complete.');

// Check query plan after ANALYZE
const result = await db.query(
  'EXPLAIN SELECT id, ts, severity, service, message FROM logs WHERE severity = $1 ORDER BY ts DESC LIMIT 100 OFFSET 50000',
  ['debug']
);
console.log('\nQuery plan for severity=debug offset=50000:');
for (const row of result.rows) {
  console.log(' ', Object.values(row)[0]);
}

// Benchmark
const times = [];
for (let i = 0; i < 20; i++) {
  const start = Date.now();
  await db.query(
    'SELECT id, ts, severity, service, message FROM logs WHERE severity = $1 ORDER BY ts DESC LIMIT 100 OFFSET 50000',
    ['debug']
  );
  times.push(Date.now() - start);
}
times.sort((a, b) => a - b);
console.log(`\nAfter ANALYZE - severity=debug offset=50000: p50=${times[10]}ms p95=${times[19]}ms min=${times[0]}ms`);

process.exit(0);
