import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
await db.exec(`CREATE TABLE test (ts TIMESTAMPTZ);`);
const d = new Date("2023-10-23T09:00:00Z");
await db.query(`INSERT INTO test (ts) VALUES ($1)`, [d]);
const res = await db.query(`SELECT ts FROM test`);
console.log(res.rows[0].ts);
