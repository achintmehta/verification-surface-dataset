const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function initDB() {
  const db = new PGlite(path.join(__dirname, 'pgdata'));
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date DATE PRIMARY KEY,
      visitors INT,
      revenue NUMERIC
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT,
      value NUMERIC
    );
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT,
      category TEXT,
      value NUMERIC,
      created_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS settings (
      id INT PRIMARY KEY,
      theme TEXT
    );
  `);

  const check = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(check.rows[0].count) === 0) {
    // Seed data
    // 30 days of metrics
    let metricsValues = [];
    let baseDate = new Date('2023-01-01T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      let d = new Date(baseDate);
      d.setDate(d.getDate() + i);
      let dateStr = d.toISOString().split('T')[0];
      // Deterministic values
      let visitors = 1000 + (i * 50) + (i % 3 === 0 ? 200 : 0);
      let revenue = 5000 + (i * 200) - (i % 4 === 0 ? 500 : 0);
      metricsValues.push(`('${dateStr}', ${visitors}, ${revenue})`);
    }
    await db.query(`INSERT INTO daily_metrics (date, visitors, revenue) VALUES ${metricsValues.join(',')}`);

    // Categories
    await db.query(`
      INSERT INTO categories (name, value) VALUES 
      ('Enterprise Infrastructure & Compliance', 1250000),
      ('Consumer Electronics', 850000),
      ('Software Subscriptions', 450000),
      ('Consulting Services', 300000),
      ('Hardware Sales', 150000),
      ('Miscellaneous', 50000)
    `);

    // Recent items
    let recentValues = [];
    for (let i = 0; i < 20; i++) {
      let d = new Date(baseDate);
      d.setDate(d.getDate() + i);
      let dateStr = d.toISOString().replace('T', ' ').substring(0, 19);
      let val = 100 + (i * 10);
      recentValues.push(`('Item ${i+1}', 'Category ${i%6}', ${val}, '${dateStr}')`);
    }
    await db.query(`INSERT INTO recent_items (name, category, value, created_at) VALUES ${recentValues.join(',')}`);

    // Settings
    await db.query(`INSERT INTO settings (id, theme) VALUES (1, 'light')`);
  }

  return db;
}

module.exports = { initDB };
