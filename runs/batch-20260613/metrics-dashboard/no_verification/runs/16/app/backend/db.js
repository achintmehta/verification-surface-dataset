const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function initDB() {
  const db = new PGlite(path.join(__dirname, 'pgdata'));
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      theme TEXT NOT NULL
    );
  `);

  const settingsCount = await db.query('SELECT COUNT(*) as count FROM settings');
  if (settingsCount.rows[0].count == 0) {
    await db.query("INSERT INTO settings (id, theme) VALUES (1, 'light')");
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date DATE PRIMARY KEY,
      visitors INTEGER NOT NULL,
      revenue NUMERIC NOT NULL
    );
  `);

  const metricsCount = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (metricsCount.rows[0].count == 0) {
    // Seed 30 days of data deterministically
    let currentDate = new Date('2023-10-01');
    for (let i = 0; i < 30; i++) {
      const dateStr = currentDate.toISOString().split('T')[0];
      // Deterministic pseudo-random values
      const visitors = 1000 + (i * 137) % 500;
      const revenue = 5000 + (i * 733) % 2000;
      await db.query('INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)', [dateStr, visitors, revenue]);
      currentDate.setDate(currentDate.getDate() + 1);
    }
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      value NUMERIC NOT NULL
    );
  `);

  const catCount = await db.query('SELECT COUNT(*) as count FROM categories');
  if (catCount.rows[0].count == 0) {
    const categories = [
      ['Enterprise Infrastructure & Compliance', 1250000], // Long label, >= 1,000,000
      ['Consumer Electronics', 850000],
      ['Software Subscriptions', 620000],
      ['Consulting Services', 430000],
      ['Hardware Sales', 210000],
      ['Miscellaneous', 95000]
    ];
    for (const [name, value] of categories) {
      await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [name, value]);
    }
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value NUMERIC NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
  `);

  const itemsCount = await db.query('SELECT COUNT(*) as count FROM recent_items');
  if (itemsCount.rows[0].count == 0) {
    let currentTimestamp = new Date('2023-10-30T12:00:00Z');
    const categories = ['Enterprise Infrastructure & Compliance', 'Consumer Electronics', 'Software Subscriptions', 'Consulting Services', 'Hardware Sales', 'Miscellaneous'];
    for (let i = 0; i < 20; i++) {
      const name = \`Item \${1000 + i}\`;
      const category = categories[i % categories.length];
      const value = 100 + (i * 47) % 900;
      const tsStr = currentTimestamp.toISOString();
      await db.query('INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)', [name, category, value, tsStr]);
      currentTimestamp.setHours(currentTimestamp.getHours() - 3);
    }
  }

  return db;
}

module.exports = { initDB };