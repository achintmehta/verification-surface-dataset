const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function test() {
    const dbPath = path.join(__dirname, 'pglite-data');
    const db = new PGlite(dbPath);
    await db.waitReady;
    
    const res = await db.query('SHOW enable_seqscan');
    console.log('enable_seqscan:', res.rows[0]);
}
test();