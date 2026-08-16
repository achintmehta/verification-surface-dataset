/**
 * Deterministic seed data for the metrics dashboard.
 * Uses a simple seeded PRNG so every boot produces identical data.
 */

// Simple mulberry32 PRNG
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateSeedData() {
  const rng = mulberry32(42);

  // --- daily_metrics: 30 rows ---
  const dailyMetrics = [];
  const baseDate = new Date('2025-01-01');
  for (let i = 0; i < 30; i++) {
    const date = new Date(baseDate);
    date.setDate(baseDate.getDate() + i);
    const dateStr = date.toISOString().slice(0, 10);
    const visitors = Math.floor(800 + rng() * 1200); // 800–2000
    const revenue = Math.round((500 + rng() * 2500) * 100) / 100; // 500–3000
    dailyMetrics.push({ date: dateStr, visitors, revenue });
  }

  // --- categories: 6 rows, one long label, one value >= 1,000,000 ---
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1250000 },
    { name: 'Marketing', value: Math.floor(200000 + rng() * 300000) },
    { name: 'Sales', value: Math.floor(300000 + rng() * 400000) },
    { name: 'Engineering', value: Math.floor(400000 + rng() * 500000) },
    { name: 'Support', value: Math.floor(100000 + rng() * 200000) },
    { name: 'Design', value: Math.floor(80000 + rng() * 150000) },
  ];

  // --- recent_items: 20 rows ---
  const itemNames = [
    'Widget Alpha', 'Widget Beta', 'Widget Gamma', 'Dashboard Pro',
    'Analytics Suite', 'Report Builder', 'Data Pipeline', 'Cloud Monitor',
    'Log Aggregator', 'Alert Manager', 'Auth Service', 'Payment Gateway',
    'Search Index', 'Cache Layer', 'Queue Worker', 'API Gateway',
    'Load Balancer', 'CDN Manager', 'DNS Resolver', 'SSL Manager',
  ];
  const categoryNames = categories.map((c) => c.name);
  const recentItems = [];
  for (let i = 0; i < 20; i++) {
    const createdAt = new Date(baseDate);
    createdAt.setDate(baseDate.getDate() + Math.floor(rng() * 30));
    createdAt.setHours(Math.floor(rng() * 24), Math.floor(rng() * 60));
    recentItems.push({
      name: itemNames[i],
      category: categoryNames[Math.floor(rng() * categoryNames.length)],
      value: Math.round((100 + rng() * 9900) * 100) / 100,
      created_at: createdAt.toISOString(),
    });
  }

  return { dailyMetrics, categories, recentItems };
}

module.exports = { generateSeedData };
