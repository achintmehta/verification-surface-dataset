const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function initDB() {
  const db = new PGlite(path.join(__dirname, 'pgdata'));
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id SERIAL PRIMARY KEY,
      theme TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date DATE PRIMARY KEY,
      visitors INTEGER NOT NULL,
      revenue NUMERIC NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      value NUMERIC NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value NUMERIC NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
  `);

  const settingsCount = await db.query('SELECT COUNT(*) FROM settings');
  if (parseInt(settingsCount.rows[0].count) === 0) {
    await db.query("INSERT INTO settings (theme) VALUES ('light')");
  }

  const metricsCount = await db.query('SELECT COUNT(*) FROM daily_metrics');
  if (parseInt(metricsCount.rows[0].count) === 0) {
    // Seed 30 days of data deterministically
    let date = new Date('2023-09-01T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      const d = date.toISOString().split('T')[0];
      const visitors = 100 + (i * 10) + (i % 3) * 15;
      const revenue = 500 + (i * 50) + (i % 5) * 100;
      await db.query('INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)', [d, visitors, revenue]);
      date.setDate(date.getDate() + 1);
    }
  }

  const categoriesCount = await db.query('SELECT COUNT(*) FROM categories');
  if (parseInt(categoriesCount.rows[0].count) === 0) {
    const cats = [
      ['Enterprise Infrastructure & Compliance', 1250000],
      ['Consumer Electronics', 850000],
      ['Software Subscriptions', 450000],
      ['Consulting Services', 250000],
      ['Hardware Sales', 150000],
      ['Miscellaneous', 50000]
    ];
    for (const [name, value] of cats) {
      await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [name, value]);
    }
  }

  const itemsCount = await db.query('SELECT COUNT(*) FROM recent_items');
  if (parseInt(itemsCount.rows[0].count) === 0) {
    let date = new Date('2023-09-30T12:00:00Z');
    for (let i = 0; i < 20; i++) {
      const name = `Item ${1000 + i}`;
      const category = i % 2 === 0 ? 'Enterprise Infrastructure & Compliance' : 'Consumer Electronics';
      const value = 100 + i * 10;
      const d = date.toISOString();
      await db.query('INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)', [name, category, value, d]);
      date.setHours(date.getHours() - 5);
    }
  }

  return db;
}

module.exports = { initDB };
