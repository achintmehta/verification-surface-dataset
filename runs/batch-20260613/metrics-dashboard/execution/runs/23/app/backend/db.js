const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

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
  const dataDir = path.join(__dirname, '..', 'pgdata');
  const db = new PGlite(dataDir);

  // Check if already seeded
  const tableCheck = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables WHERE table_name = 'daily_metrics'
    ) AS seeded
  `);

  if (tableCheck.rows[0].seeded) {
    console.log('Database already seeded.');
    return db;
  }

  console.log('Creating schema and seeding data...');

  // Create tables one at a time (PGLite doesn't support multi-statement)
  await db.query(`
    CREATE TABLE daily_metrics (
      id SERIAL PRIMARY KEY,
      metric_date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      value BIGINT NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Seed with deterministic data
  const rng = mulberry32(42);

  // daily_metrics: 30 days starting from a fixed base date
  const baseDate = new Date('2025-01-01');
  for (let i = 0; i < 30; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = Math.floor(rng() * 70000) + 20000; // 20000-90000
    const revenue = Math.floor(rng() * 4000000 + 500000) / 100; // 5000.00 - 45000.00
    await db.query(
      'INSERT INTO daily_metrics (metric_date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // categories: 6 rows, one long label, one value >= 1,000,000
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 2345678 },
    { name: 'Marketing', value: 876543 },
    { name: 'Sales', value: 654321 },
    { name: 'Engineering', value: 543210 },
    { name: 'Support', value: 321098 },
    { name: 'Design', value: 198765 }
  ];
  for (const cat of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [cat.name, cat.value]);
  }

  // recent_items: 20 rows
  const itemNames = [
    'Alpha Report', 'Beta Analysis', 'Gamma Overview', 'Delta Summary', 'Epsilon Review',
    'Zeta Dashboard', 'Eta Pipeline', 'Theta Module', 'Iota Service', 'Kappa Widget',
    'Lambda Process', 'Mu Integration', 'Nu Platform', 'Xi Framework', 'Omicron Tool',
    'Pi System', 'Rho Engine', 'Sigma Controller', 'Tau Handler', 'Upsilon Manager'
  ];
  const catNames = categories.map(c => c.name);
  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[Math.floor(rng() * catNames.length)];
    const value = Math.floor(rng() * 9000000 + 10000) / 100;
    const createdAt = new Date(baseDate);
    createdAt.setDate(createdAt.getDate() + Math.floor(rng() * 30));
    createdAt.setHours(Math.floor(rng() * 24), Math.floor(rng() * 60));
    const ts = createdAt.toISOString().replace('T', ' ').slice(0, 19);
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, ts]
    );
  }

  // Default settings
  await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light')");

  console.log('Seeding complete.');
  return db;
}

module.exports = { initDB };
