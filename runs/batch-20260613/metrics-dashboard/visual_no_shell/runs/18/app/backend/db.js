const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'pglite-data3');

const db = new PGlite(dbPath);

async function initDb() {
  await db.waitReady;
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date DATE PRIMARY KEY,
      visitors INT NOT NULL,
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
    
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const { rows: metricsRows } = await db.query('SELECT count(*) as count FROM daily_metrics');
  if (parseInt(metricsRows[0].count) === 0) {
    // Seed daily_metrics (30 days)
    let metricsValues = [];
    let baseDate = new Date('2023-10-01T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      let d = new Date(baseDate);
      d.setDate(d.getDate() + i);
      let dateStr = d.toISOString().split('T')[0];
      let visitors = 1000 + Math.floor(Math.sin(i) * 200) + i * 10;
      let revenue = 50000 + Math.floor(Math.cos(i) * 1000) + i * 50;
      metricsValues.push(`('${dateStr}', ${visitors}, ${revenue})`);
    }
    await db.exec(`INSERT INTO daily_metrics (date, visitors, revenue) VALUES ${metricsValues.join(', ')}`);

    // Seed categories
    await db.exec(`
      INSERT INTO categories (name, value) VALUES
      ('Enterprise Infrastructure & Compliance Management Solutions', 1250000),
      ('Consumer Electronics', 450000),
      ('Software Subscriptions', 320000),
      ('Consulting Services', 150000),
      ('Hardware Maintenance', 85000),
      ('Miscellaneous', 42000)
    `);

    // Seed recent_items
    let itemsValues = [];
    for (let i = 0; i < 20; i++) {
      let name = `Item ${i + 1}`;
      let category = i % 2 === 0 ? 'Enterprise Infrastructure & Compliance Management Solutions' : 'Consumer Electronics';
      let value = 100 + i * 15;
      let d = new Date(baseDate);
      d.setDate(d.getDate() + 29);
      d.setHours(10 + (i % 10), i * 2, 0);
      let created_at = d.toISOString().replace('T', ' ').substring(0, 19);
      itemsValues.push(`('${name}', '${category}', ${value}, '${created_at}')`);
    }
    await db.exec(`INSERT INTO recent_items (name, category, value, created_at) VALUES ${itemsValues.join(', ')}`);

    // Seed settings
    await db.exec(`INSERT INTO settings (key, value) VALUES ('theme', 'light')`);
  }
}

module.exports = { db, initDb };
