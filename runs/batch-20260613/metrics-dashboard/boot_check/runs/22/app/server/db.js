const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function initDB() {
  const dbPath = path.join(__dirname, '..', 'pgdata');
  const db = new PGlite(dbPath);

  // Check if already seeded
  try {
    const check = await db.query(`SELECT EXISTS (
      SELECT FROM information_schema.tables WHERE table_name = 'daily_metrics'
    ) AS exists`);
    if (check.rows[0].exists) {
      console.log('Database already seeded.');
      return db;
    }
  } catch (e) {
    // table doesn't exist yet, proceed with seeding
  }

  console.log('Creating schema and seeding data...');

  // Create tables
  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      value INTEGER NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(255) NOT NULL,
      value NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(100) PRIMARY KEY,
      value VARCHAR(255) NOT NULL
    );
  `);

  // Deterministic seed: seeded random number generator
  // Simple mulberry32 PRNG
  function mulberry32(a) {
    return function() {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const rand = mulberry32(42);

  // Seed daily_metrics: 30 days ending today-like fixed date (2025-01-30)
  const baseDate = new Date('2025-01-01');
  for (let i = 0; i < 30; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const visitors = Math.floor(rand() * 4000) + 500;
    const revenue = Math.floor(rand() * 50000 + 1000) / 100 * 100; // round to hundreds
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, Math.round(revenue * 100) / 100]
    );
  }

  // Seed categories: 6 rows, one with a long label, one with value >= 1,000,000
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1284567 },
    { name: 'Marketing', value: 456200 },
    { name: 'Sales', value: 789300 },
    { name: 'Engineering', value: 623400 },
    { name: 'Support', value: 312100 },
    { name: 'Operations', value: 198700 }
  ];
  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // Seed recent_items: 20 rows
  const catNames = categories.map(c => c.name);
  const itemPrefixes = [
    'Widget', 'Report', 'Analysis', 'Dashboard', 'Pipeline',
    'Module', 'Service', 'Platform', 'Integration', 'Connector',
    'Adapter', 'Gateway', 'Monitor', 'Tracker', 'Engine',
    'Workflow', 'Processor', 'Handler', 'Controller', 'Scheduler'
  ];
  for (let i = 0; i < 20; i++) {
    const name = `${itemPrefixes[i]} ${String.fromCharCode(65 + (i % 26))}${i + 1}`;
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = Math.round((rand() * 99000 + 1000) * 100) / 100;
    const daysAgo = Math.floor(rand() * 30);
    const createdAt = new Date('2025-01-30');
    createdAt.setDate(createdAt.getDate() - daysAgo);
    createdAt.setHours(Math.floor(rand() * 24), Math.floor(rand() * 60));
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdAt.toISOString()]
    );
  }

  // Seed settings
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light')"
  );

  console.log('Seeding complete.');
  return db;
}

module.exports = { initDB };
