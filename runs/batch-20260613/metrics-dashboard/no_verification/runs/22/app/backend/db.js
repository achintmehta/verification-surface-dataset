import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'pgdata');

let db = null;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  await db.waitReady;
  return db;
}

export async function initDb() {
  const pg = await getDb();

  // Check if already seeded
  const tableCheck = await pg.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_name = 'daily_metrics'
    ) AS table_exists
  `);

  if (tableCheck.rows[0].table_exists) {
    console.log('Database already seeded.');
    return pg;
  }

  console.log('Creating schema and seeding data...');

  // Create tables
  await pg.query(`
    CREATE TABLE daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12, 2) NOT NULL
    );
  `);

  await pg.query(`
    CREATE TABLE categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      value INTEGER NOT NULL
    );
  `);

  await pg.query(`
    CREATE TABLE recent_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(255) NOT NULL,
      value NUMERIC(12, 2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
  `);

  await pg.query(`
    CREATE TABLE settings (
      key VARCHAR(100) PRIMARY KEY,
      value VARCHAR(255) NOT NULL
    );
  `);

  // Seed deterministic data
  await seedData(pg);

  console.log('Database seeded successfully.');
  return pg;
}

// Simple seeded PRNG (mulberry32)
function mulberry32(seed) {
  return function() {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

async function seedData(pg) {
  const rng = mulberry32(42);

  // Seed daily_metrics: 30 days ending today (2024-01-30 as fixed reference)
  const baseDate = new Date('2024-01-01');
  for (let i = 0; i < 30; i++) {
    const date = new Date(baseDate);
    date.setDate(baseDate.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    const visitors = Math.floor(rng() * 4000) + 500;
    const revenue = Math.floor(rng() * 50000 + 1000) / 100 * 100;
    await pg.query(
      `INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)`,
      [dateStr, visitors, revenue]
    );
  }

  // Seed categories: 6 rows, one with a long label, one value >= 1,000,000
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1284753 },
    { name: 'Marketing', value: 456200 },
    { name: 'Sales', value: 789100 },
    { name: 'Engineering', value: 623400 },
    { name: 'Support', value: 198700 },
    { name: 'Analytics', value: 345600 },
  ];
  for (const cat of categories) {
    await pg.query(
      `INSERT INTO categories (name, value) VALUES ($1, $2)`,
      [cat.name, cat.value]
    );
  }

  // Seed recent_items: 20 rows
  const itemCategories = ['Sales', 'Marketing', 'Engineering', 'Support', 'Analytics', 'Enterprise Infrastructure & Compliance'];
  const itemNames = [
    'Widget Alpha', 'Service Beta', 'Platform Gamma', 'Tool Delta',
    'Module Epsilon', 'System Zeta', 'App Eta', 'Suite Theta',
    'Package Iota', 'Solution Kappa', 'Framework Lambda', 'Library Mu',
    'Plugin Nu', 'Extension Xi', 'Gateway Omicron', 'Portal Pi',
    'Engine Rho', 'Interface Sigma', 'Console Tau', 'Dashboard Upsilon'
  ];
  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = itemCategories[Math.floor(rng() * itemCategories.length)];
    const value = Math.floor(rng() * 100000) / 100;
    const createdAt = new Date(baseDate);
    createdAt.setDate(baseDate.getDate() + Math.floor(rng() * 30));
    createdAt.setHours(Math.floor(rng() * 24), Math.floor(rng() * 60));
    await pg.query(
      `INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)`,
      [name, category, value, createdAt.toISOString()]
    );
  }

  // Seed settings
  await pg.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light')`
  );
}
