const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

async function initDB() {
  const db = new PGlite(DB_PATH);

  // Check if already seeded
  const tableCheck = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables WHERE table_name = 'daily_metrics'
    ) AS exists
  `);

  if (tableCheck.rows[0].exists) {
    console.log('Database already seeded.');
    return db;
  }

  console.log('Creating schema and seeding data...');

  // Create tables
  await db.query(`
    CREATE TABLE daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12, 2) NOT NULL
    );

    CREATE TABLE categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      value INTEGER NOT NULL
    );

    CREATE TABLE recent_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(255) NOT NULL,
      value NUMERIC(12, 2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE settings (
      key VARCHAR(64) PRIMARY KEY,
      value VARCHAR(255) NOT NULL
    );
  `);

  // Deterministic seed using a simple seeded PRNG
  // Mulberry32 PRNG
  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const rand = mulberry32(42);

  function randInt(min, max) {
    return Math.floor(rand() * (max - min + 1)) + min;
  }

  function randFixed(min, max, decimals = 2) {
    return (rand() * (max - min) + min).toFixed(decimals);
  }

  // Seed daily_metrics: 30 days ending today (use a fixed "today" for determinism)
  const baseDate = new Date('2025-01-15');
  for (let i = 29; i >= 0; i--) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = randInt(800, 5000);
    const revenue = randFixed(1000, 15000);
    await db.query(
      `INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)`,
      [dateStr, visitors, revenue]
    );
  }

  // Seed categories: 6 rows, one long label, one value >= 1,000,000
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1234567 },
    { name: 'Cloud Services', value: 845200 },
    { name: 'Mobile Apps', value: 623400 },
    { name: 'Analytics', value: 412300 },
    { name: 'Security', value: 289100 },
    { name: 'Support', value: 156800 },
  ];
  for (const cat of categories) {
    await db.query(
      `INSERT INTO categories (name, value) VALUES ($1, $2)`,
      [cat.name, cat.value]
    );
  }

  // Seed recent_items: 20 rows
  const itemNames = [
    'Dashboard Redesign', 'API Gateway', 'Auth Module', 'Payment Integration',
    'Search Engine', 'Notification Service', 'User Analytics', 'Data Pipeline',
    'CI/CD Setup', 'Load Balancer', 'Cache Layer', 'Monitoring Tool',
    'Billing System', 'Report Generator', 'Email Service', 'Webhook Handler',
    'Rate Limiter', 'File Storage', 'Audit Logger', 'Config Manager'
  ];
  const catNames = categories.map(c => c.name);
  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[i % catNames.length];
    const value = randFixed(100, 50000);
    const createdAt = new Date(baseDate);
    createdAt.setDate(createdAt.getDate() - i);
    createdAt.setHours(randInt(8, 20), randInt(0, 59), randInt(0, 59));
    await db.query(
      `INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)`,
      [name, category, value, createdAt.toISOString()]
    );
  }

  // Seed settings
  await db.query(`INSERT INTO settings (key, value) VALUES ('theme', 'light')`);

  console.log('Database seeded successfully.');
  return db;
}

module.exports = { initDB };
