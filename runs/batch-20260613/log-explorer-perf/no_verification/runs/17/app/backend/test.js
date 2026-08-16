const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function test() {
    const db = new PGlite(path.join(__dirname, 'pgdata'));
    await db.waitReady;
    
    console.time('offset 99900');
    await db.query('SELECT id, ts, severity, service, message FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 99900;');
    console.timeEnd('offset 99900');

    console.time('offset 99900 with severity');
    await db.query("SELECT id, ts, severity, service, message FROM logs WHERE severity = 'info' ORDER BY ts DESC LIMIT 100 OFFSET 20000;");
    console.timeEnd('offset 99900 with severity');

    console.time('offset 99900 with q');
    await db.query("SELECT id, ts, severity, service, message FROM logs WHERE message ILIKE '%laptop%' ORDER BY ts DESC LIMIT 100 OFFSET 10000;");
    console.timeEnd('offset 99900 with q');
}

test();
