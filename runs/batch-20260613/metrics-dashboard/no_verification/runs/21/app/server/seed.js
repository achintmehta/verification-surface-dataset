/**
 * Deterministic seed for the metrics dashboard.
 * Uses a simple seeded PRNG (mulberry32) so every boot produces identical data.
 */

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seed(db) {
  // Check if already seeded by looking for the daily_metrics table
  try {
    const check = await db.query(`
      SELECT count(*)::integer AS c FROM daily_metrics
    `);
    if (parseInt(check.rows[0].c, 10) > 0) {
      console.log('Database already seeded, skipping.');
      return;
    }
  } catch {
    // Table doesn't exist yet, proceed with seeding
  }

  console.log('Creating schema and seeding data...');

  // Create tables
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
      key VARCHAR(64) PRIMARY KEY,
      value VARCHAR(255) NOT NULL
    );
  `);

  const rand = mulberry32(42);

  // Seed daily_metrics: 30 days ending today-ish (use a fixed end date for determinism)
  const baseDate = new Date('2025-01-15');
  for (let i = 0; i < 30; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() - 29 + i);
    const dateStr = d.toISOString().split('T')[0];
    const visitors = Math.floor(rand() * 4000) + 1000; // 1000-5000
    const revenue = Math.floor(rand() * 900000 + 100000) / 100; // 1000.00 - 10000.00
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // Seed categories: 6 rows, one with a deliberately long name, one with value >= 1,000,000
  const categories = [
    { name: 'Web Analytics', value: Math.floor(rand() * 500000) + 100000 },
    { name: 'Mobile Apps', value: Math.floor(rand() * 500000) + 100000 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 + Math.floor(rand() * 250000) },
    { name: 'Cloud Services', value: Math.floor(rand() * 500000) + 200000 },
    { name: 'Data Pipeline', value: Math.floor(rand() * 400000) + 150000 },
    { name: 'IoT Devices', value: Math.floor(rand() * 300000) + 50000 },
  ];

  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // Seed recent_items: 20 rows
  const itemNames = [
    'Dashboard Redesign', 'API Gateway', 'User Onboarding', 'Search Index',
    'Payment Flow', 'Notification Hub', 'Analytics Engine', 'Auth Service',
    'CDN Migration', 'Load Balancer', 'Log Aggregator', 'Alert Monitor',
    'Config Service', 'Rate Limiter', 'Cache Layer', 'Queue Worker',
    'Schema Registry', 'Feature Flags', 'A/B Testing', 'Data Export'
  ];
  const catNames = categories.map(c => c.name);

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = Math.floor(rand() * 9000000 + 100000) / 100; // up to ~90000
    const createdAt = new Date(baseDate);
    createdAt.setDate(createdAt.getDate() - Math.floor(rand() * 30));
    createdAt.setHours(Math.floor(rand() * 24), Math.floor(rand() * 60));
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdAt.toISOString()]
    );
  }

  // Seed default settings
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light')"
  );

  console.log('Seeding complete.');
}
