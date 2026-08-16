const { PGlite } = require("@electric-sql/pglite");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "pgdata");

/**
 * Simple deterministic pseudo-random number generator (mulberry32).
 * Takes a seed and returns a function that produces numbers in [0, 1).
 */
function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function initDB() {
  const db = new PGlite(DB_PATH);

  // Check if already seeded
  const tableCheck = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_name = 'daily_metrics'
    ) AS exists
  `);

  if (tableCheck.rows[0].exists) {
    console.log("Database already initialized, skipping seed.");
    return db;
  }

  console.log("Initializing database and seeding data...");

  // ==================== Schema ====================

  await db.query(`
    CREATE TABLE daily_metrics (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12, 2) NOT NULL
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
      value INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // ==================== Deterministic Seed ====================
  const rand = mulberry32(42);

  // --- daily_metrics: 30 rows ---
  const baseDate = new Date("2025-01-01");
  for (let i = 0; i < 30; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD

    // Visitors: 800–5000 with some variability
    const visitors = Math.floor(800 + rand() * 4200);
    // Revenue: roughly $5–$15 per visitor
    const revenuePerVisitor = 5 + rand() * 10;
    const revenue = (visitors * revenuePerVisitor).toFixed(2);

    await db.query(
      "INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)",
      [dateStr, visitors, revenue]
    );
  }

  // --- categories: 6 rows, one long label, one value ≥ 1,000,000 ---
  const categoryData = [
    { name: "Enterprise Infrastructure & Compliance", value: 1_245_890 },
    { name: "Marketing", value: 845_320 },
    { name: "Engineering", value: 723_150 },
    { name: "Sales", value: 651_400 },
    { name: "Support", value: 412_780 },
    { name: "Design", value: 298_500 },
  ];

  for (const cat of categoryData) {
    await db.query(
      "INSERT INTO categories (name, value) VALUES ($1, $2)",
      [cat.name, cat.value]
    );
  }

  // --- recent_items: 20 rows ---
  const itemNames = [
    "Dashboard Redesign",
    "API Gateway Migration",
    "Mobile App v3.0",
    "Cloud Cost Optimization",
    "Security Audit Q1",
    "Customer Portal Update",
    "Data Pipeline Refactor",
    "ML Model Deployment",
    "Infrastructure Scaling",
    "Performance Monitoring",
    "CI/CD Pipeline Setup",
    "Database Migration",
    "Load Balancer Config",
    "SSL Certificate Renewal",
    "Backup Strategy Review",
    "User Analytics Setup",
    "Payment Integration",
    "Email Service Migration",
    "Cache Layer Implementation",
    "Compliance Reporting Tool",
  ];

  const categoryNames = [
    "Enterprise Infrastructure & Compliance",
    "Marketing",
    "Engineering",
    "Sales",
    "Support",
    "Design",
  ];

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = categoryNames[Math.floor(rand() * categoryNames.length)];
    const value = Math.floor(1000 + rand() * 99000);
    const daysAgo = Math.floor(rand() * 30);
    const itemDate = new Date(baseDate);
    itemDate.setDate(itemDate.getDate() + 30 - daysAgo);
    const created_at = itemDate.toISOString();

    await db.query(
      "INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)",
      [name, category, value, created_at]
    );
  }

  // --- settings: default theme ---
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light')"
  );

  console.log("Database seeded successfully.");
  return db;
}

module.exports = { initDB };
