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
    
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
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
      // Deterministic pseudo-random
      let visitors = 1000 + (i * 137) % 500;
      let revenue = 5000 + (i * 733) % 2000;
      metricsValues.push(`('${dateStr}', ${visitors}, ${revenue})`);
    }
    await db.query(`INSERT INTO daily_metrics (date, visitors, revenue) VALUES ${metricsValues.join(',')}`);

    // Seed categories
    await db.query(`
      INSERT INTO categories (name, value) VALUES 
      ('Enterprise Infrastructure & Compliance', 1250000),
      ('Consumer Electronics', 450000),
      ('Software Subscriptions', 320000),
      ('Consulting Services', 150000),
      ('Hardware Sales', 80000),
      ('Other', 25000)
    `);

    // Seed recent_items
    let itemsValues = [];
    for (let i = 0; i < 20; i++) {
      let d = new Date(baseDate);
      d.setDate(d.getDate() + 29);
      d.setHours(10 + (i % 8), i % 60, 0);
      let dateStr = d.toISOString();
      let name = `Order #${1000 + i}`;
      let category = i % 2 === 0 ? 'Enterprise Infrastructure & Compliance' : 'Consumer Electronics';
      let value = 100 + (i * 47) % 500;
      itemsValues.push(`('${name}', '${category}', ${value}, '${dateStr}')`);
    }
    await db.query(`INSERT INTO recent_items (name, category, value, created_at) VALUES ${itemsValues.join(',')}`);

    // Seed settings
    await db.query(`INSERT INTO settings (key, value) VALUES ('theme', 'light')`);
    
    console.log("Database seeded.");
  }
}

module.exports = { db, initDb };