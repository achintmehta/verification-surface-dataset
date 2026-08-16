import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '..', 'pgdata');

export async function initDB() {
  const db = new PGlite(DB_PATH);

  // Check if already seeded
  try {
    const check = await db.query(`SELECT to_regclass('public.daily_metrics') as t`);
    if (check.rows[0].t) {
      console.log('Database already seeded.');
      return db;
    }
  } catch (e) {
    // table doesn't exist, proceed with seeding
  }

  console.log('Seeding database...');

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
      key VARCHAR(50) PRIMARY KEY,
      value VARCHAR(255) NOT NULL
    );
  `);

  // Deterministic seed using a simple seeded PRNG
  function seededRandom(seed) {
    let s = seed;
    return function() {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  const rng = seededRandom(42);

  // Seed daily_metrics: 30 days ending today-like fixed date
  // Use a fixed base date for determinism: 2024-01-30
  const baseDate = new Date('2024-01-30');
  for (let i = 29; i >= 0; i--) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const visitors = Math.floor(rng() * 4000) + 1000; // 1000-5000
    const revenue = Math.floor(rng() * 90000 + 10000) / 100; // 100.00 - 1000.00
    await db.query(
      `INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)`,
      [dateStr, visitors, revenue]
    );
  }

  // Seed categories: 6 rows, one with long label, one with value >= 1,000,000
  const categories = [
    { name: 'Sales', value: 245000 },
    { name: 'Marketing', value: 182000 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'Support', value: 98000 },
    { name: 'Engineering', value: 520000 },
    { name: 'Operations', value: 310000 }
  ];

  for (const cat of categories) {
    await db.query(
      `INSERT INTO categories (name, value) VALUES ($1, $2)`,
      [cat.name, cat.value]
    );
  }

  // Seed recent_items: 20 rows
  const itemNames = [
    'Widget Alpha', 'Widget Beta', 'Widget Gamma', 'Widget Delta', 'Widget Epsilon',
    'Service Plan A', 'Service Plan B', 'Service Plan C', 'Service Plan D', 'Service Plan E',
    'License Tier 1', 'License Tier 2', 'License Tier 3', 'License Tier 4', 'License Tier 5',
    'Addon Pack X', 'Addon Pack Y', 'Addon Pack Z', 'Custom Solution', 'Premium Bundle'
  ];
  const catNames = categories.map(c => c.name);

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[Math.floor(rng() * catNames.length)];
    const value = Math.floor(rng() * 999900 + 100) / 100;
    const createdAt = new Date(baseDate);
    createdAt.setDate(createdAt.getDate() - Math.floor(rng() * 30));
    createdAt.setHours(Math.floor(rng() * 24), Math.floor(rng() * 60));
    await db.query(
      `INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)`,
      [name, category, value, createdAt.toISOString()]
    );
  }

  // Seed settings
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light')`
  );

  console.log('Database seeded successfully.');
  return db;
}
