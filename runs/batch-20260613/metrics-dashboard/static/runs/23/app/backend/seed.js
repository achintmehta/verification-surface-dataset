/**
 * Deterministic seed data generator.
 * Uses a simple seeded PRNG (mulberry32) so every boot produces identical data.
 */

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

  // Helper: random int in [min, max]
  const randInt = (min, max) => Math.floor(rng() * (max - min + 1)) + min;

  // --- daily_metrics: 30 rows ---
  const dailyMetrics = [];
  const startDate = new Date('2025-01-01');
  for (let i = 0; i < 30; i++) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + i);
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    const visitors = randInt(800, 5000);
    const revenue = parseFloat((rng() * 9000 + 1000).toFixed(2)); // 1000–10000
    dailyMetrics.push({ date: dateStr, visitors, revenue });
  }

  // --- categories: 6 rows, one long label, one value >= 1,000,000 ---
  const categoryNames = [
    'Enterprise Infrastructure & Compliance',
    'Mobile Apps',
    'Cloud Services',
    'Analytics',
    'Developer Tools',
    'Support'
  ];
  const categories = categoryNames.map((name, idx) => {
    let value;
    if (idx === 0) {
      // Ensure >= 1,000,000
      value = randInt(1000000, 9999999);
    } else {
      value = randInt(10000, 500000);
    }
    return { name, value };
  });

  // --- recent_items: 20 rows ---
  const itemPrefixes = [
    'Widget', 'Module', 'Service', 'Package', 'Component',
    'Library', 'Plugin', 'Extension', 'Framework', 'Toolkit',
    'Gateway', 'Connector', 'Adapter', 'Driver', 'Agent',
    'Monitor', 'Scanner', 'Resolver', 'Handler', 'Processor'
  ];
  const recentItems = [];
  for (let i = 0; i < 20; i++) {
    const name = `${itemPrefixes[i]} ${String.fromCharCode(65 + (i % 26))}${randInt(100, 999)}`;
    const category = categoryNames[i % categoryNames.length];
    const value = parseFloat((rng() * 50000 + 500).toFixed(2));
    // Spread items over last 30 days
    const createdAt = new Date(startDate);
    createdAt.setDate(startDate.getDate() + randInt(0, 29));
    createdAt.setHours(randInt(0, 23), randInt(0, 59), randInt(0, 59));
    recentItems.push({
      name,
      category,
      value,
      created_at: createdAt.toISOString()
    });
  }

  return { dailyMetrics, categories, recentItems };
}

module.exports = { generateSeedData };
