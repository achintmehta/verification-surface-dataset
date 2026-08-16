const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function initDB() {
  const db = new PGlite(path.join(__dirname, '../pglite-data-2'));
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      theme TEXT NOT NULL
    );
  `);

  const settingsRes = await db.query('SELECT COUNT(*) as count FROM settings');
  if (settingsRes.rows[0].count == 0) {
    await db.query("INSERT INTO settings (id, theme) VALUES (1, 'light')");
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date INTEGER PRIMARY KEY,
      visitors INTEGER NOT NULL,
      revenue NUMERIC NOT NULL
    );
  `);

  const metricsRes = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (metricsRes.rows[0].count == 0) {
    // Seed 30 days
    let insertQuery = 'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ';
    const values = [];
    let baseDate = 1704067200; // Jan 1, 2024
    for (let i = 0; i < 30; i++) {
      // Deterministic pseudo-random
      const visitors = 10000 + (i * 17) % 5000;
      const revenue = 50000 + (i * 23) % 20000;
      values.push(`(${baseDate + i * 86400}, ${visitors}, ${revenue})`);
    }
    await db.query(insertQuery + values.join(', '));
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      value NUMERIC NOT NULL
    );
  `);

  const catRes = await db.query('SELECT COUNT(*) as count FROM categories');
  if (catRes.rows[0].count == 0) {
    await db.query(`
      INSERT INTO categories (name, value) VALUES 
      ('Enterprise Infrastructure & Compliance', 1250000),
      ('Consumer Electronics', 850000),
      ('Software Subscriptions', 450000),
      ('Consulting Services', 250000),
      ('Hardware Sales', 150000),
      ('Other', 50000)
    `);
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value NUMERIC NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  const recentRes = await db.query('SELECT COUNT(*) as count FROM recent_items');
  if (recentRes.rows[0].count == 0) {
    let insertQuery = 'INSERT INTO recent_items (name, category, value, created_at) VALUES ';
    const values = [];
    let baseDate = 1706659200; // Jan 31, 2024
    const categories = ['Enterprise Infrastructure & Compliance', 'Consumer Electronics', 'Software Subscriptions', 'Consulting Services', 'Hardware Sales', 'Other'];
    for (let i = 0; i < 20; i++) {
      const name = 'Item ' + (i + 1);
      const category = categories[i % categories.length];
      const value = 100 + (i * 37) % 900;
      values.push(`('${name}', '${category}', ${value}, ${baseDate - i * 3600})`);
    }
    await db.query(insertQuery + values.join(', '));
  }

  return db;
}

module.exports = { initDB };
