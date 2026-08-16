const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

let db = null;

// Simple seeded PRNG (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function initDB() {
  const dbPath = path.join(__dirname, '..', 'pgdata');
  db = new PGlite(dbPath);

  // Check if already seeded
  const tableCheck = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables WHERE table_name = 'daily_metrics'
    ) AS exists
  `);

  if (tableCheck.rows[0].exists) {
    console.log('Database already seeded.');
    return;
  }

  console.log('Creating schema and seeding data...');

  // Create schema
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
      name TEXT NOT NULL,
      value INTEGER NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Deterministic seed
  const rng = mulberry32(42);

  // Seed daily_metrics: 30 days ending today (use a fixed "today" for determinism)
  const baseDate = new Date('2025-01-30');
  for (let i = 29; i >= 0; i--) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = Math.floor(rng() * 4000) + 500;
    const revenue = Math.floor(rng() * 50000) / 100 + 100;
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // Seed categories: 6 rows, one with a deliberately long name, one with value >= 1,000,000
  const categoryData = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'Cloud Services', value: 842000 },
    { name: 'Mobile Apps', value: 534000 },
    { name: 'Analytics', value: 321000 },
    { name: 'Security', value: 198000 },
    { name: 'Support', value: 95000 },
  ];
  for (const cat of categoryData) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [
      cat.name,
      cat.value,
    ]);
  }

  // Seed recent_items: 20 rows
  const itemCategories = ['Sales', 'Marketing', 'Engineering', 'Support', 'Finance'];
  const itemPrefixes = ['Widget', 'Gadget', 'Service', 'Module', 'Package', 'Solution', 'Platform', 'Tool', 'System', 'Suite'];
  const itemSuffixes = ['Alpha', 'Beta', 'Pro', 'Plus', 'Core', 'Lite', 'Max', 'Ultra', 'Prime', 'One'];
  for (let i = 0; i < 20; i++) {
    const name = `${itemPrefixes[i % itemPrefixes.length]} ${itemSuffixes[Math.floor(rng() * itemSuffixes.length)]}`;
    const category = itemCategories[Math.floor(rng() * itemCategories.length)];
    const value = Math.floor(rng() * 100000) / 100 + 10;
    const daysAgo = Math.floor(rng() * 30);
    const createdAt = new Date(baseDate);
    createdAt.setDate(createdAt.getDate() - daysAgo);
    createdAt.setHours(Math.floor(rng() * 24), Math.floor(rng() * 60));
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdAt.toISOString()]
    );
  }

  // Default settings
  await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light')");

  console.log('Database seeded successfully.');
}

function getDB() {
  return db;
}

module.exports = { initDB, getDB };
