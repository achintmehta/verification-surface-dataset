const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const { generateSeedData } = require('./seed');

let db = null;

async function getDb() {
  if (db) return db;

  const dataDir = path.join(__dirname, '..', 'pgdata');
  db = new PGlite(dataDir);

  await initSchema();
  return db;
}

async function initSchema() {
  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12, 2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      value INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value NUMERIC(12, 2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const check = await db.query('SELECT COUNT(*)::int AS cnt FROM daily_metrics');
  if (check.rows[0].cnt > 0) {
    return; // already seeded
  }

  const { dailyMetrics, categories, recentItems } = generateSeedData();

  // Seed daily_metrics
  for (const row of dailyMetrics) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [row.date, row.visitors, row.revenue]
    );
  }

  // Seed categories
  for (const row of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [row.name, row.value]
    );
  }

  // Seed recent_items
  for (const row of recentItems) {
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [row.name, row.category, row.value, row.created_at]
    );
  }

  // Seed default theme
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING"
  );

  console.log('Database seeded successfully.');
}

module.exports = { getDb };
