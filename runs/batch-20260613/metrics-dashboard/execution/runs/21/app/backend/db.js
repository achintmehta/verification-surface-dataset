const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

// Deterministic seed: simple seeded PRNG (mulberry32)
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
  const db = new PGlite(DB_PATH);

  // Check if already seeded
  try {
    const check = await db.query("SELECT COUNT(*)::int AS cnt FROM daily_metrics");
    if (check.rows[0].cnt > 0) {
      console.log('Database already seeded.');
      return db;
    }
  } catch (e) {
    // Table doesn't exist yet, proceed with creation
  }

  console.log('Creating schema and seeding data...');

  // Create tables (PGLite requires one statement per query call)
  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      visitors INT NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      value INT NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value INT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const rng = mulberry32(42);

  // Seed daily_metrics: 30 days
  const baseDate = new Date('2025-01-01');
  for (let i = 0; i < 30; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const visitors = Math.floor(rng() * 4000) + 500;
    const revenue = Math.floor(rng() * 50000 + 1000) / 100;
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // Seed categories: 6 rows, one with a deliberately long label, one with value >= 1,000,000
  const categoryData = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 + Math.floor(rng() * 100000) },
    { name: 'Marketing', value: Math.floor(rng() * 500000) + 50000 },
    { name: 'Sales', value: Math.floor(rng() * 400000) + 80000 },
    { name: 'Engineering', value: Math.floor(rng() * 600000) + 100000 },
    { name: 'Design', value: Math.floor(rng() * 200000) + 30000 },
    { name: 'Support', value: Math.floor(rng() * 300000) + 40000 },
  ];

  for (const cat of categoryData) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // Seed recent_items: 20 rows
  const itemNames = [
    'Alpha Project', 'Beta Initiative', 'Gamma Platform', 'Delta Module',
    'Epsilon Service', 'Zeta Dashboard', 'Eta Analytics', 'Theta Report',
    'Iota Integration', 'Kappa Workflow', 'Lambda Pipeline', 'Mu Component',
    'Nu Framework', 'Xi Processor', 'Omicron System', 'Pi Controller',
    'Rho Engine', 'Sigma Toolkit', 'Tau Monitor', 'Upsilon Gateway'
  ];
  const catNames = categoryData.map(c => c.name);

  for (let i = 0; i < 20; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + Math.floor(rng() * 30));
    const createdAt = d.toISOString().split('T')[0];
    const value = Math.floor(rng() * 10000) + 100;
    const category = catNames[Math.floor(rng() * catNames.length)];
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [itemNames[i], category, value, createdAt]
    );
  }

  // Seed default settings
  await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");

  console.log('Seeded database successfully.');
  return db;
}

module.exports = { initDB };
