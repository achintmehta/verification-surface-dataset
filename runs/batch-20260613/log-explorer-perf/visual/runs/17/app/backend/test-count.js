const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function test() {
    const dbPath = path.join(__dirname, 'pglite-data');
    const db = new PGlite(dbPath);
    await db.waitReady;
    
    const res = await db.query(`EXPLAIN ANALYZE SELECT COUNT(*) FROM logs WHERE message ILIKE '%e%'`);
    console.log(res.rows.map(r => r['QUERY PLAN']).join('\\n'));
}
test();