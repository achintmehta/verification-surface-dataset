import { PGlite } from '@electric-sql/pglite';

async function test() {
  const db = new PGlite('./pglite-data');
  await db.waitReady;
  
  async function measure(query, name) {
    const times = [];
    for (let i = 0; i < 20; i++) {
      const start = Date.now();
      await db.query(query);
      times.push(Date.now() - start);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    console.log(`${name} p95: ${p95}ms`);
  }

  await measure('SELECT id, ts, severity, service, message FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 0', 'offset 0');
  await measure('SELECT id, ts, severity, service, message FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 50000', 'offset 50k');
  await measure('SELECT * FROM (SELECT id, ts, severity, service, message FROM logs ORDER BY ts ASC LIMIT 100 OFFSET 0) sub ORDER BY ts DESC', 'offset 99.9k optimized');
  await measure("SELECT * FROM (SELECT id, ts, severity, service, message FROM logs WHERE severity = 'info' ORDER BY ts ASC LIMIT 100 OFFSET 5000) sub ORDER BY ts DESC", 'severity deep optimized');
  await measure("SELECT * FROM (SELECT id, ts, severity, service, message FROM logs WHERE message ILIKE '%user%' ORDER BY ts ASC LIMIT 100 OFFSET 5000) sub ORDER BY ts DESC", 'non-selective deep optimized');
  await measure("SELECT * FROM (SELECT id, ts, severity, service, message FROM logs WHERE message ILIKE '%failed%' ORDER BY ts ASC LIMIT 100 OFFSET 5000) sub ORDER BY ts DESC", 'selective deep optimized');

  await measure("SELECT id, ts, severity, service, message FROM logs WHERE severity = 'info' ORDER BY ts DESC LIMIT 100 OFFSET 20000", 'severity deep');
  await measure("SELECT id, ts, severity, service, message FROM logs WHERE message ILIKE '%user%' ORDER BY ts DESC LIMIT 100 OFFSET 10000", 'non-selective deep');
  await measure("SELECT id, ts, severity, service, message FROM logs WHERE message ILIKE '%failed%' ORDER BY ts DESC LIMIT 100 OFFSET 5000", 'selective deep');
}

test().catch(console.error);
