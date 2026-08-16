import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'pglite');

// Ensure the data directory exists before PGLite tries to use it
fs.mkdirSync(DB_PATH, { recursive: true });

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  await db.waitReady;
  return db;
}

// Simple seeded pseudo-random number generator (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function initDb() {
  const db = await getDb();

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      value BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const { rows: existing } = await db.query(
    'SELECT COUNT(*) as cnt FROM daily_metrics'
  );
  if (parseInt(existing[0].cnt, 10) > 0) {
    console.log('[db] Already seeded, skipping.');
    return;
  }

  console.log('[db] Seeding database...');
  const rand = mulberry32(42);

  // Seed daily_metrics: 30 days ending yesterday
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = Math.floor(rand() * 4000) + 500;   // 500–4500
    const revenue = (rand() * 9000 + 1000).toFixed(2);  // 1000–10000
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // Seed categories (6 rows, one long label, one value >= 1,000,000)
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1_284_500 },
    { name: 'Cloud Services', value: Math.floor(rand() * 500000) + 200000 },
    { name: 'Professional Services', value: Math.floor(rand() * 300000) + 100000 },
    { name: 'Support & Maintenance', value: Math.floor(rand() * 200000) + 50000 },
    { name: 'Training', value: Math.floor(rand() * 100000) + 20000 },
    { name: 'Consulting', value: Math.floor(rand() * 150000) + 30000 },
  ];
  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // Seed recent_items (20 rows)
  const catNames = categories.map((c) => c.name);
  const itemPrefixes = [
    'Project', 'Contract', 'Invoice', 'Order', 'Ticket',
    'Request', 'Proposal', 'Report', 'Task', 'Issue',
  ];
  const now = new Date();
  for (let i = 0; i < 20; i++) {
    const prefix = itemPrefixes[i % itemPrefixes.length];
    const name = `${prefix} #${1000 + i}`;
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = (rand() * 50000 + 500).toFixed(2);
    const createdAt = new Date(now.getTime() - Math.floor(rand() * 30) * 86400000);
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdAt.toISOString()]
    );
  }

  // Seed default settings
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light')
     ON CONFLICT (key) DO NOTHING`
  );

  console.log('[db] Seeding complete.');
}
