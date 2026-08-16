let PGlite;
import('@electric-sql/pglite').then(m => PGlite = m.PGlite);
const path = require('path');

let db;

async function initDb() {
  if (!PGlite) {
    const m = await import('@electric-sql/pglite');
    PGlite = m.PGlite;
  }
  db = new PGlite(path.join(__dirname, 'pglite-data'));

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
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const { rows: metricsRows } = await db.query('SELECT count(*) as count FROM daily_metrics');
  if (parseInt(metricsRows[0].count) === 0) {
    // Seed daily_metrics (30 days)
    let metricsInsert = 'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ';
    const metricsValues = [];
    const baseDate = new Date('2023-10-01T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      const d = new Date(baseDate);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];
      // Deterministic pseudo-random
      const visitors = Math.floor(1000 + Math.sin(i) * 500 + i * 10);
      const revenue = Math.floor(5000 + Math.cos(i) * 2000 + i * 50);
      metricsValues.push(`('${dateStr}', ${visitors}, ${revenue})`);
    }
    await db.exec(metricsInsert + metricsValues.join(', '));

    // Seed categories
    await db.exec(`
      INSERT INTO categories (name, value) VALUES
      ('Enterprise Infrastructure & Compliance', 1250000),
      ('Consumer Electronics', 450000),
      ('Software Subscriptions', 320000),
      ('Consulting Services', 150000),
      ('Hardware Sales', 80000),
      ('Other', 25000)
    `);

    // Seed recent_items
    let itemsInsert = 'INSERT INTO recent_items (name, category, value, created_at) VALUES ';
    const itemsValues = [];
    for (let i = 0; i < 20; i++) {
      const name = "Item " + (i + 1);
      const category = i % 2 === 0 ? 'Enterprise Infrastructure & Compliance' : 'Consumer Electronics';
      const value = Math.floor(100 + (i * 137) % 1000);
      const d = new Date(baseDate);
      d.setDate(d.getDate() + 29);
      d.setHours(12 - i);
      const dateStr = d.toISOString().replace('T', ' ').substring(0, 19);
      itemsValues.push("('" + name + "', '" + category + "', " + value + ", '" + dateStr + "')");
    }
    await db.exec(itemsInsert + itemsValues.join(', '));

    // Seed settings
    await db.exec(`INSERT INTO settings (key, value) VALUES ('theme', 'light')`);
  }
}

module.exports = { getDb: () => db, initDb };
