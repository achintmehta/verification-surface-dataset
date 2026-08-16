const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const { generateSeedData } = require('./seed');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

async function initDatabase() {
  const db = new PGlite(DB_PATH);

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(10, 2) NOT NULL
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
      value NUMERIC(10, 2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*) as cnt FROM daily_metrics');
  const count = parseInt(countResult.rows[0].cnt, 10);

  if (count === 0) {
    console.log('Seeding database...');
    const { dailyMetrics, categories, recentItems } = generateSeedData();

    // Insert daily_metrics
    for (const row of dailyMetrics) {
      await db.query(
        'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
        [row.date, row.visitors, row.revenue]
      );
    }

    // Insert categories
    for (const row of categories) {
      await db.query(
        'INSERT INTO categories (name, value) VALUES ($1, $2)',
        [row.name, row.value]
      );
    }

    // Insert recent_items
    for (const row of recentItems) {
      await db.query(
        'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
        [row.name, row.category, row.value, row.created_at]
      );
    }

    // Default settings
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING"
    );

    console.log('Database seeded successfully.');
  } else {
    console.log('Database already seeded.');
  }

  return db;
}

module.exports = { initDatabase };
