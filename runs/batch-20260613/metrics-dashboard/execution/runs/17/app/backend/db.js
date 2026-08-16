import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const db = new PGlite('./pgdata');

export async function initDb() {
  await db.waitReady;
  
  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date DATE PRIMARY KEY,
      visitors INTEGER,
      revenue NUMERIC
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT,
      value NUMERIC
    );
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT,
      category TEXT,
      value NUMERIC,
      created_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Check if seeded
  const res = await db.query(`SELECT count(*) as count FROM daily_metrics`);
  if (parseInt(res.rows[0].count) === 0) {
    console.log("Seeding database...");
    
    // Seed daily_metrics (30 days)
    let baseDate = new Date('2023-10-01T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      let d = new Date(baseDate);
      d.setDate(d.getDate() + i);
      let dateStr = d.toISOString().split('T')[0];
      let visitors = 100 + (i * 13) % 50 + (i % 7) * 20;
      let revenue = visitors * 2.5 + (i * 7) % 100;
      await db.query(`INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)`, [dateStr, visitors, revenue]);
    }

    // Seed categories
    const cats = [
      { name: "Enterprise Infrastructure & Compliance", value: 1250000 },
      { name: "Consumer Electronics", value: 450000 },
      { name: "Software Subscriptions", value: 320000 },
      { name: "Consulting Services", value: 150000 },
      { name: "Hardware Maintenance", value: 85000 },
      { name: "Miscellaneous", value: 12000 }
    ];
    for (const c of cats) {
      await db.query(`INSERT INTO categories (name, value) VALUES ($1, $2)`, [c.name, c.value]);
    }

    // Seed recent_items
    for (let i = 0; i < 20; i++) {
      let name = `Item ${1000 + i * 7}`;
      let category = cats[i % cats.length].name;
      let value = 50 + (i * 17) % 200;
      let d = new Date(baseDate);
      d.setDate(d.getDate() + 29);
      d.setHours(10 + (i % 10), i % 60, 0);
      await db.query(`INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)`, [name, category, value, d.toISOString()]);
    }

    // Seed settings
    await db.query(`INSERT INTO settings (key, value) VALUES ('theme', 'light')`);
  }
}

export default db;