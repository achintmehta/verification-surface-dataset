const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function test() {
    const dbPath = path.join(__dirname, 'pglite-data');
    const db = new PGlite(dbPath);
    await db.waitReady;
    
    await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts_id ON logs(ts DESC, id);');
    await db.exec('VACUUM ANALYZE logs;');
    
    const res = await db.query('EXPLAIN ANALYZE SELECT id FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 50000');
    console.log(res.rows.map(r => r['QUERY PLAN']).join('\\n'));
}
test();