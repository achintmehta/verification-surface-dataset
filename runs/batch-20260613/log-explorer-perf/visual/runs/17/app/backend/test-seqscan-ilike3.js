const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function test() {
    const dbPath = path.join(__dirname, 'pglite-data');
    const db = new PGlite(dbPath);
    await db.waitReady;
    
    await db.query('SET enable_indexscan = off;');
    const res = await db.query(`EXPLAIN ANALYZE SELECT * FROM logs WHERE message ILIKE '%e%' ORDER BY ts DESC LIMIT 100 OFFSET 50000`);
    console.log(res.rows.map(r => r['QUERY PLAN']).join('\\n'));
}
test();