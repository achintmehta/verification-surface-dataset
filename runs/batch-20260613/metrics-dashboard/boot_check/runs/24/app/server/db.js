import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '..', 'pgdata');

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

export async function initDB() {
  const db = new PGlite(DB_PATH);

  // Check if already seeded
  const check = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables WHERE table_name = 'daily_metrics'
    ) AS seeded
  `);

  if (check.rows[0].seeded) {
    console.log('Database already seeded.');
    return db;
  }

  console.log('Seeding database...');

  // Create tables
  await db.exec(`
    CREATE TABLE daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      value INTEGER NOT NULL
    );

    CREATE TABLE recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Seed settings
  await db.query(`INSERT INTO settings (key, value) VALUES ('theme', 'light')`);

  const rng = mulberry32(42);

  // Seed daily_metrics: 30 days ending today (2024-01-30 as fixed reference)
  const baseDate = new Date('2024-01-01');
  for (let i = 0; i < 30; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const visitors = Math.floor(rng() * 5000) + 500;
    const revenue = Math.floor(rng() * 50000 + 1000) + rng() * 100;
    await db.query(
      `INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)`,
      [dateStr, visitors, parseFloat(revenue.toFixed(2))]
    );
  }

  // Seed categories: 6 rows, one long label, one value >= 1,000,000
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1523847 },
    { name: 'Analytics', value: 842300 },
    { name: 'Marketing', value: 634500 },
    { name: 'Sales', value: 456200 },
    { name: 'Support', value: 312100 },
    { name: 'R&D', value: 278400 },
  ];
  for (const cat of categories) {
    await db.query(
      `INSERT INTO categories (name, value) VALUES ($1, $2)`,
      [cat.name, cat.value]
    );
  }

  // Seed recent_items: 20 rows
  const itemCategories = ['Analytics', 'Marketing', 'Sales', 'Support', 'R&D', 'Enterprise Infrastructure & Compliance'];
  const itemNames = [
    'Dashboard Redesign', 'Campaign Alpha', 'Lead Gen v2', 'Ticket System Upgrade',
    'ML Pipeline', 'SEO Audit', 'CRM Integration', 'Email Automation',
    'Customer Feedback Loop', 'Data Warehouse Migration', 'API Gateway',
    'Mobile App v3', 'Security Patch', 'Performance Tuning', 'Brand Refresh',
    'Onboarding Flow', 'Revenue Tracker', 'Compliance Report', 'Infrastructure Scaling', 'User Research'
  ];

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = itemCategories[Math.floor(rng() * itemCategories.length)];
    const value = parseFloat((rng() * 100000 + 500).toFixed(2));
    const createdAt = new Date(baseDate);
    createdAt.setDate(createdAt.getDate() + Math.floor(rng() * 30));
    createdAt.setHours(Math.floor(rng() * 24), Math.floor(rng() * 60));
    await db.query(
      `INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)`,
      [name, category, value, createdAt.toISOString()]
    );
  }

  console.log('Database seeded successfully.');
  return db;
}
