const { PGlite } = require('@electric-sql/pglite');

async function test() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity VARCHAR(10) NOT NULL,
      service VARCHAR(50) NOT NULL,
      message TEXT NOT NULL
    );
  `);

  let seed = 12345;
  function random() {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  }

  const BATCH_SIZE = 5000;
  for (let i = 0; i < 100000; i += BATCH_SIZE) {
    let values = [];
    for (let j = 0; j < BATCH_SIZE; j++) {
      values.push(`('2023-01-01T00:00:00Z', 'info', 'service', 'Message ${Math.floor(random() * 100000)}')`);
    }
    await db.exec(`INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')};`);
  }

  await db.exec('CREATE INDEX idx_logs_ts ON logs(ts DESC);');

  const start = Date.now();
  const res = await db.query(`SELECT COUNT(*) FROM logs WHERE message ILIKE '%123%'`);
  console.log('Count Time:', Date.now() - start, 'ms', 'Count:', res.rows[0].count);
}
test();