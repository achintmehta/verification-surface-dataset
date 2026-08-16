const { PGlite } = require('@electric-sql/pglite');
async function test() {
  const db = new PGlite('./test-db');
  await db.waitReady;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMP NOT NULL,
        severity VARCHAR(10) NOT NULL,
        service VARCHAR(50) NOT NULL,
        message TEXT NOT NULL
    );
  `);
  const res = await db.query(`SELECT COUNT(*) as count FROM logs`);
  if (res.rows[0].count == 0) {
    console.log('seeding');
    await db.exec('BEGIN');
    for (let i=0; i<100000; i+=1000) {
      let vals = [];
      for (let j=0; j<1000; j++) {
        vals.push(`('2023-01-01', 'info', 'api', 'some message ${i+j}')`);
      }
      await db.exec(`INSERT INTO logs (ts, severity, service, message) VALUES ${vals.join(',')}`);
    }
    await db.exec('CREATE INDEX idx_ts ON logs(ts DESC);');
    await db.exec('COMMIT');
  }
  console.time('ilike');
  await db.query(`SELECT * FROM logs WHERE message ILIKE '%99999%' ORDER BY ts DESC LIMIT 100 OFFSET 0`);
  console.timeEnd('ilike');
}
test();