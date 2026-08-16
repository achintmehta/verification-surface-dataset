const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function test() {
    const dbPath = path.join(__dirname, 'pglite-data');
    const db = new PGlite(dbPath);
    await db.waitReady;
    
    await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts_message ON logs(ts DESC, message);');
    await db.exec('VACUUM ANALYZE logs;');
    
    const res = await db.query(`
        EXPLAIN ANALYZE 
        SELECT * FROM logs WHERE id IN (
            SELECT id FROM logs WHERE message ILIKE '%e%' ORDER BY ts DESC LIMIT 100 OFFSET 50000
        ) ORDER BY ts DESC
    `);
    console.log(res.rows.map(r => r['QUERY PLAN']).join('\\n'));
}
test();