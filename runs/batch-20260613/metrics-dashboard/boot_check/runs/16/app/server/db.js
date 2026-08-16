import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';

const dbPath = path.join(process.cwd(), 'pglite-data');
const db = new PGlite(dbPath);

export async function initDb() {
  await db.waitReady;
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date DATE PRIMARY KEY,
      visitors INT,
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
      id INT PRIMARY KEY,
      theme TEXT
    );
  `);

  const res = await db.query(`SELECT count(*) as count FROM daily_metrics`);
  if (parseInt(res.rows[0].count) === 0) {
    let date = new Date('2023-09-01T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      const d = new Date(date);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];
      const visitors = Math.floor(1000 + Math.sin(i) * 500 + i * 50);
      const revenue = Math.floor(5000 + Math.cos(i) * 2000 + i * 200);
      await db.query(`INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)`, [dateStr, visitors, revenue]);
    }

    const cats = [
      ['Enterprise Infrastructure & Compliance', 1250000],
      ['Consumer Electronics', 450000],
      ['Software Subscriptions', 320000],
      ['Consulting Services', 150000],
      ['Hardware Sales', 80000],
      ['Miscellaneous', 25000]
    ];
    for (const cat of cats) {
      await db.query(`INSERT INTO categories (name, value) VALUES ($1, $2)`, cat);
    }

    for (let i = 0; i < 20; i++) {
      const name = `Item ${i + 1}`;
      const category = cats[i % cats.length][0];
      const value = Math.floor(100 + Math.sin(i * 13) * 50 + i * 10);
      const d = new Date(date);
      d.setDate(d.getDate() + i);
      d.setHours(12 + (i % 10));
      await db.query(`INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)`, [name, category, value, d.toISOString()]);
    }

    await db.query(`INSERT INTO settings (id, theme) VALUES (1, 'light')`);
  }
}

export default db;