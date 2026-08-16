import { PGlite } from '@electric-sql/pglite';

async function test() {
  const db = new PGlite();
  await db.query(`
    CREATE TABLE logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity VARCHAR(10) NOT NULL,
      service VARCHAR(50) NOT NULL,
      message TEXT NOT NULL
    );
  `);
  await db.query(`CREATE INDEX idx_logs_ts ON logs(ts DESC);`);
  await db.query(`CREATE INDEX idx_logs_severity_ts ON logs(severity, ts DESC);`);
  
  console.log("Seeding...");
  let rows = [];
  for (let i = 0; i < 100000; i++) {
    rows.push(`('2023-01-01 00:00:00', 'info', 'svc', 'msg ${i}')`);
    if (rows.length === 5000) {
      await db.query(`INSERT INTO logs (ts, severity, service, message) VALUES ${rows.join(',')}`);
      rows = [];
    }
  }
  
  console.log("Testing offset...");
  const start = Date.now();
  await db.query(`SELECT * FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 99000`);
  console.log("Time:", Date.now() - start, "ms");
}
test();
