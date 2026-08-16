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
  
  console.log('Seeding...');
  const batchSize = 5000;
  for (let i = 0; i < 100000; i += batchSize) {
    let values = [];
    for (let j = 0; j < batchSize; j++) {
      values.push(`('2023-01-01', 'info', 'service', 'This is a test message with some random data ${Math.random()}')`);
    }
    await db.exec(`INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')};`);
  }
  
  await db.exec(`
    CREATE INDEX idx_logs_ts ON logs (ts DESC);
    CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC);
  `);
  
  console.log('Querying...');
  const start = Date.now();
  const res = await db.query(`SELECT COUNT(*) FROM logs WHERE severity = 'info'`);
  console.log('Time:', Date.now() - start, 'ms');
}
test();