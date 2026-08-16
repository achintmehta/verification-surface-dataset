import { PGlite } from '@electric-sql/pglite';
const db = new PGlite('./db');
const res = await db.query("SELECT hold_expires_at FROM seats WHERE id = 'A1'");
console.log(typeof res.rows[0].hold_expires_at, res.rows[0].hold_expires_at);
