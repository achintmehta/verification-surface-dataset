const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function initDB() {
  const db = new PGlite(path.join(__dirname, '../pglite-data'));
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date TEXT PRIMARY KEY,
      visitors INTEGER,
      revenue NUMERIC
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT,
      value NUMERIC
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT,
      category TEXT,
      value NUMERIC,
      created_at TEXT
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      theme TEXT
    );
  `);

  const check = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(check.rows[0].count) === 0) {
    console.log('Seeding database...');
    
    let date = new Date('2023-09-01T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      const d = date.toISOString().split('T')[0];
      const visitors = 100 + (i * 17 % 50);
      const revenue = 500 + (i * 23 % 200);
      await db.query('INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)', [d, visitors, revenue]);
      date.setDate(date.getDate() + 1);
    }

    const cats = [
      { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
      { name: 'Consumer Electronics', value: 450000 },
      { name: 'Software Subscriptions', value: 320000 },
      { name: 'Consulting Services', value: 150000 },
      { name: 'Hardware Sales', value: 80000 },
      { name: 'Other', value: 25000 }
    ];
    for (const c of cats) {
      await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [c.name, c.value]);
    }

    for (let i = 0; i < 20; i++) {
      const name = `Item ${i + 1}`;
      const category = cats[i % cats.length].name;
      const value = 100 + (i * 13 % 900);
      const created_at = new Date(Date.now() - i * 3600000).toISOString();
      await db.query('INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)', [name, category, value, created_at]);
    }

    await db.query('INSERT INTO settings (id, theme) VALUES (1, $1)', ['light']);
  }

  return db;
}

module.exports = { initDB };
