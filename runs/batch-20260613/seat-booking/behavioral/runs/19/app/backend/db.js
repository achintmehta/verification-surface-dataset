import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../data');

export const db = new PGlite(dbPath);

export async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      hold_id TEXT,
      hold_expires_at BIGINT,
      booked_by TEXT
    );
  `);

  const res = await db.query(`SELECT count(*) as count FROM seats`);
  if (parseInt(res.rows[0].count, 10) === 0) {
    const rows = ['A', 'B', 'C', 'D', 'E'];
    for (const row of rows) {
      for (let i = 1; i <= 10; i++) {
        const id = `${row}${i}`;
        await db.query(
          `INSERT INTO seats (id, row_label, seat_number) VALUES ($1, $2, $3)`,
          [id, row, i]
        );
      }
    }
  }
}
