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
      visitors INT NOT NULL,
      revenue NUMERIC(10, 2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      value NUMERIC(15, 2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(255) NOT NULL,
      value NUMERIC(10, 2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(50) PRIMARY KEY,
      value VARCHAR(255) NOT NULL
    );
  `);

  // Check if seeded
  const res = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(res.rows[0].count) === 0) {
    console.log('Seeding database...');
    
    // Seed daily_metrics (30 days)
    let metricsValues = [];
    let baseDate = new Date('2023-10-01T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      let d = new Date(baseDate);
      d.setDate(d.getDate() + i);
      let dateStr = d.toISOString().split('T')[0];
      // Deterministic pseudo-random values
      let visitors = 1000 + (i * 17) % 500 + (i % 7 === 0 ? 800 : 0);
      let revenue = 5000 + (i * 23) % 2000 + (i % 5 === 0 ? 1500 : 0);
      metricsValues.push(`('${dateStr}', ${visitors}, ${revenue})`);
    }
    await db.exec(`INSERT INTO daily_metrics (date, visitors, revenue) VALUES ${metricsValues.join(', ')}`);

    // Seed categories (6 rows)
    await db.exec(`
      INSERT INTO categories (name, value) VALUES
      ('Enterprise Infrastructure & Compliance', 1250000.00),
      ('Consumer Electronics', 450000.00),
      ('Software Subscriptions', 320000.00),
      ('Consulting Services', 150000.00),
      ('Hardware Sales', 85000.00),
      ('Miscellaneous', 12000.00)
    `);

    // Seed recent_items (20 rows)
    let itemsValues = [];
    for (let i = 0; i < 20; i++) {
      let d = new Date(baseDate);
      d.setDate(d.getDate() + 29);
      d.setHours(10 + (i % 8), (i * 13) % 60, 0);
      let dateStr = d.toISOString().replace('T', ' ').substring(0, 19);
      let name = \`Item \${i + 1}\`;
      let category = i % 2 === 0 ? 'Enterprise Infrastructure & Compliance' : 'Consumer Electronics';
      let value = 100 + (i * 37) % 900;
      itemsValues.push(`('${name}', '${category}', ${value}, '${dateStr}')`);
    }
    await db.exec(`INSERT INTO recent_items (name, category, value, created_at) VALUES ${itemsValues.join(', ')}`);

    // Seed settings
    await db.exec(`INSERT INTO settings (key, value) VALUES ('theme', 'light')`);
    console.log('Database seeded.');
  }
}

module.exports = { db, initDb };
