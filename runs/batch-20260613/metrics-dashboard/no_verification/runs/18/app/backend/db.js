const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const dbPath = path.join(__dirname, 'pglite-data');
const db = new PGlite(dbPath);

async function initDb() {
  await db.waitReady;
  
  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date DATE PRIMARY KEY,
      visitors INTEGER,
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
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Check if seeded
  const res = await db.query(`SELECT count(*) as count FROM daily_metrics`);
  if (parseInt(res.rows[0].count) === 0) {
    console.log("Seeding database...");
    // Seed daily_metrics (30 days)
    let metricsValues = [];
    let baseDate = new Date('2023-10-01T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      let d = new Date(baseDate);
      d.setDate(d.getDate() + i);
      let dateStr = d.toISOString().split('T')[0];
      // Deterministic values
      let visitors = 1000 + (i * 50) + (i % 3 === 0 ? 200 : 0) - (i % 7 === 0 ? 300 : 0);
      let revenue = visitors * 2.5 + (i % 5 === 0 ? 500 : 0);
      metricsValues.push(`('${dateStr}', ${visitors}, ${revenue})`);
    }
    await db.exec(`INSERT INTO daily_metrics (date, visitors, revenue) VALUES ${metricsValues.join(',')}`);

    // Seed categories (6 rows, one long label, one value >= 1,000,000)
    await db.exec(`
      INSERT INTO categories (name, value) VALUES
      ('Enterprise Infrastructure & Compliance', 1250000),
      ('Consumer Electronics', 450000),
      ('Software Subscriptions', 320000),
      ('Consulting Services', 150000),
      ('Hardware Sales', 85000),
      ('Miscellaneous', 12000)
    `);

    // Seed recent_items (20 rows)
    let itemsValues = [];
    for (let i = 1; i <= 20; i++) {
      let name = \`Item \${i}\`;
      let category = i % 2 === 0 ? 'Enterprise Infrastructure & Compliance' : 'Consumer Electronics';
      let value = 100 + (i * 15);
      let d = new Date(baseDate);
      d.setDate(d.getDate() + 29);
      d.setHours(10 + (i % 10), i % 60, 0);
      let created_at = d.toISOString().replace('T', ' ').substring(0, 19);
      itemsValues.push(`('\${name}', '\${category}', \${value}, '\${created_at}')`);
    }
    await db.exec(`INSERT INTO recent_items (name, category, value, created_at) VALUES ${itemsValues.join(',')}`);

    // Seed settings
    await db.exec(`INSERT INTO settings (key, value) VALUES ('theme', 'light')`);
  }
}

module.exports = { db, initDb };