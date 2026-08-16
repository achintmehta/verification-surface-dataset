// PGLite initialization, schema creation, and deterministic seeding.
import { PGlite } from "@electric-sql/pglite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildSeed } from "./seed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Persist the database to the local file system (a directory PGLite manages).
const DATA_DIR = path.resolve(__dirname, "..", "pgdata");

let db = null;

async function createSchema(database) {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12, 2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      value BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value NUMERIC(12, 2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      theme TEXT NOT NULL DEFAULT 'light',
      CONSTRAINT settings_singleton CHECK (id = 1)
    );
  `);
}

async function seedIfEmpty(database) {
  const res = await database.query(`SELECT COUNT(*)::int AS n FROM daily_metrics;`);
  const count = res.rows[0]?.n ?? 0;
  if (count > 0) {
    // Ensure settings row exists even if previously seeded.
    await database.exec(
      `INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING;`
    );
    return;
  }

  const { dailyMetrics, categories, recentItems } = buildSeed();

  for (const m of dailyMetrics) {
    await database.query(
      `INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)
       ON CONFLICT (date) DO NOTHING;`,
      [m.date, m.visitors, m.revenue]
    );
  }

  for (const c of categories) {
    await database.query(
      `INSERT INTO categories (name, value) VALUES ($1, $2);`,
      [c.name, c.value]
    );
  }

  for (const r of recentItems) {
    await database.query(
      `INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4);`,
      [r.name, r.category, r.value, r.created_at]
    );
  }

  await database.query(
    `INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING;`
  );
}

export async function getDb() {
  if (db) return db;
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  await createSchema(db);
  await seedIfEmpty(db);
  return db;
}
