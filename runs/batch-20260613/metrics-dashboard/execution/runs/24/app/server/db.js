const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const { generateSeedData } = require('./seed');

let db = null;

async function getDb() {
  if (db) return db;

  const dbPath = path.join(__dirname, '..', 'pgdata');
  db = new PGlite(dbPath);

  // Check if tables exist already
  const tableCheck = await db.query(`
    SELECT EXISTS (
      SELECT FROM pg_tables WHERE tablename = 'daily_metrics'
    ) AS exists
  `);

  if (!tableCheck.rows[0].exists) {
    await initSchema();
    await seedData();
    console.log('Database seeded successfully.');
  } else {
    console.log('Database already seeded.');
  }

  return db;
}

async function initSchema() {
  // PGlite's exec() supports multiple statements
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
      value INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

async function seedData() {
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
    "INSERT INTO settings (key, value) VALUES ('theme', 'light')"
  );
}

module.exports = { getDb };
