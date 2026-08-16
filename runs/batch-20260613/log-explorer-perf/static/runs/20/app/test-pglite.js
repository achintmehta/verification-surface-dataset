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

  console.log('Inserting...');
  const batchSize = 5000;
  for (let i = 0; i < 100000; i += batchSize) {
    let values = [];
    for (let j = 0; j < batchSize; j++) {
      values.push(`('2023-10-01T00:00:00Z', 'info', 'service', 'message ${i+j}')`);
    }
    await db.exec(`INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')};`);
  }

  await db.exec(`CREATE INDEX idx_logs_ts ON logs (ts DESC);`);

  console.log('Querying...');
  const start = Date.now();
  await db.query(`SELECT * FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 90000`);
  console.log('Time:', Date.now() - start, 'ms');
}

test().catch(console.error);
