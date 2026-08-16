const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function test() {
    const dbPath = path.join(__dirname, 'pglite-data');
    const db = new PGlite(dbPath);
    await db.waitReady;
    
    await db.exec(`
        CREATE OR REPLACE FUNCTION make_trigrams(text) RETURNS tsvector AS $$
        DECLARE
            result text := '';
            i int;
        BEGIN
            FOR i IN 1..length($1)-2 LOOP
                result := result || ' ' || substring($1 from i for 3);
            END LOOP;
            RETURN to_tsvector('simple', result);
        END;
        $$ LANGUAGE plpgsql IMMUTABLE;
    `);
    
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_trgm ON logs USING GIN (make_trigrams(lower(message)));`);
    
    const res = await db.query(`
        EXPLAIN ANALYZE 
        SELECT * FROM logs 
        WHERE make_trigrams(lower(message)) @@ to_tsquery('simple', 'out')
        ORDER BY ts DESC LIMIT 100 OFFSET 50000
    `);
    console.log(res.rows.map(r => r['QUERY PLAN']).join('\\n'));
}
test();