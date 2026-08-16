import { PGlite } from '@electric-sql/pglite';
import { getSeedData } from './seed.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'pglite');

let db;

export async function initDb() {
  db = new PGlite(DB_PATH);
  await db.waitReady;

  // Create schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date        DATE PRIMARY KEY,
      visitors    INTEGER NOT NULL,
      revenue     NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id    SERIAL PRIMARY KEY,
      name  TEXT NOT NULL UNIQUE,
      value NUMERIC(14,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      category   TEXT NOT NULL,
      value      NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM daily_metrics');
  const count = parseInt(rows[0].cnt, 10);

  if (count === 0) {
    const { dailyMetrics, categories, recentItems } = getSeedData();

    for (const row of dailyMetrics) {
      await db.query(
        'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
        [row.date, row.visitors, row.revenue]
      );
    }

    for (const cat of categories) {
      await db.query(
        'INSERT INTO categories (name, value) VALUES ($1, $2)',
        [cat.name, cat.value]
      );
    }

    for (const item of recentItems) {
      await db.query(
        'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
        [item.name, item.category, item.value, item.created_at]
      );
    }

    // Default theme
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING"
    );

    console.log('Database seeded.');
  } else {
    console.log('Database already seeded, skipping.');
  }

  return db;
}

export function getDb() {
  return db;
}
