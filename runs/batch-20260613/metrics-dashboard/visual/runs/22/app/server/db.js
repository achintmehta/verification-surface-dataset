const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

let dbInstance = null;

async function initDB() {
  if (dbInstance) return dbInstance;
  
  const dbPath = path.join(__dirname, '..', 'pgdata');
  dbInstance = new PGlite(dbPath);
  
  // Create tables
  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12, 2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      value INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(255) NOT NULL,
      value NUMERIC(12, 2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(50) PRIMARY KEY,
      value VARCHAR(255) NOT NULL
    );
  `);

  return dbInstance;
}

// Simple seeded random number generator (mulberry32)
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

async function seedDB(db) {
  // Check if already seeded
  const check = await db.query('SELECT COUNT(*) as cnt FROM daily_metrics');
  if (parseInt(check.rows[0].cnt) > 0) {
    console.log('Database already seeded, skipping.');
    return;
  }

  console.log('Seeding database...');
  const rng = mulberry32(42);

  // Seed daily_metrics: 30 days
  const today = new Date('2025-01-30');
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const visitors = Math.floor(rng() * 4000) + 1000; // 1000–5000
    const revenue = (rng() * 9000 + 1000).toFixed(2); // 1000–10000
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // Seed categories: 6 rows, including one long label and one value >= 1,000,000
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1283450 },
    { name: 'Cloud Services', value: 845200 },
    { name: 'Data Analytics', value: 623800 },
    { name: 'Mobile Apps', value: 412300 },
    { name: 'Security', value: 298700 },
    { name: 'IoT Devices', value: 187500 },
  ];
  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // Seed recent_items: 20 rows
  const itemNames = [
    'Alpha Platform', 'Beta Module', 'Gamma Service', 'Delta Widget',
    'Epsilon Connector', 'Zeta Dashboard', 'Eta Processor', 'Theta Engine',
    'Iota Scanner', 'Kappa Monitor', 'Lambda Integration', 'Mu Controller',
    'Nu Pipeline', 'Xi Optimizer', 'Omicron Gateway', 'Pi Scheduler',
    'Rho Validator', 'Sigma Reporter', 'Tau Analyzer', 'Upsilon Tracker'
  ];
  const itemCategories = ['Cloud Services', 'Data Analytics', 'Mobile Apps', 'Security', 'IoT Devices', 'Enterprise Infrastructure & Compliance'];

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = itemCategories[i % itemCategories.length];
    const value = (rng() * 50000 + 500).toFixed(2);
    const createdAt = new Date(today);
    createdAt.setDate(createdAt.getDate() - Math.floor(rng() * 30));
    createdAt.setHours(Math.floor(rng() * 24), Math.floor(rng() * 60));
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdAt.toISOString()]
    );
  }

  // Seed default settings
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING"
  );

  console.log('Database seeded successfully.');
}

module.exports = { initDB, seedDB };
