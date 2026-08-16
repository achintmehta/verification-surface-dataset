const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function initDB() {
  const db = new PGlite(path.join(__dirname, 'pglite-data'));
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id SERIAL PRIMARY KEY,
      theme VARCHAR(10) NOT NULL
    );
  `);

  const settingsCount = await db.query('SELECT COUNT(*) FROM settings');
  if (parseInt(settingsCount.rows[0].count) === 0) {
    await db.query("INSERT INTO settings (theme) VALUES ('light')");
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date DATE PRIMARY KEY,
      visitors INT NOT NULL,
      revenue NUMERIC(10, 2) NOT NULL
    );
  `);

  const metricsCount = await db.query('SELECT COUNT(*) FROM daily_metrics');
  if (parseInt(metricsCount.rows[0].count) === 0) {
    let date = new Date('2023-10-01');
    for (let i = 0; i < 30; i++) {
      const dateStr = date.toISOString().split('T')[0];
      const visitors = 100 + (i * 17) % 50;
      const revenue = 40000 + (i * 1234) % 5000;
      await db.query('INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)', [dateStr, visitors, revenue]);
      date.setDate(date.getDate() + 1);
    }
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      value NUMERIC(15, 2) NOT NULL
    );
  `);

  const catCount = await db.query('SELECT COUNT(*) FROM categories');
  if (parseInt(catCount.rows[0].count) === 0) {
    const categories = [
      ['Enterprise Infrastructure & Compliance', 1250000.00],
      ['Consumer Electronics', 450000.00],
      ['Software Subscriptions', 320000.00],
      ['Consulting Services', 150000.00],
      ['Hardware Sales', 85000.00],
      ['Miscellaneous', 12000.00]
    ];
    for (const cat of categories) {
      await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', cat);
    }
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(255) NOT NULL,
      value NUMERIC(10, 2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
  `);

  const itemsCount = await db.query('SELECT COUNT(*) FROM recent_items');
  if (parseInt(itemsCount.rows[0].count) === 0) {
    let created_at = new Date('2023-10-30T10:00:00Z');
    for (let i = 0; i < 20; i++) {
      const name = `Item ${i + 1}`;
      const category = ['Enterprise Infrastructure & Compliance', 'Consumer Electronics', 'Software Subscriptions'][i % 3];
      const value = 100 + (i * 73) % 200;
      await db.query('INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)', [name, category, value, created_at.toISOString()]);
      created_at.setHours(created_at.getHours() - 2);
    }
  }

  return db;
}

module.exports = { initDB };
