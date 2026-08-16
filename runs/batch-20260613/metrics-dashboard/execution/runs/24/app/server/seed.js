// Deterministic seed data generator
// Uses a simple seeded PRNG for reproducibility

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
  const baseDate = new Date('2025-01-01');
  for (let i = 0; i < 30; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = randInt(800, 5000);
    const revenue = parseFloat((randInt(2000, 15000) + rng() * 100).toFixed(2));
    dailyMetrics.push({ date: dateStr, visitors, revenue });
  }

  // --- categories: 6 rows, one with long name, one with value >= 1,000,000 ---
  const categoryNames = [
    'Marketing',
    'Sales',
    'Engineering',
    'Enterprise Infrastructure & Compliance',
    'Support',
    'Design'
  ];
  const categories = categoryNames.map((name, i) => {
    let value;
    if (i === 3) {
      // The long-name category gets a 7-digit value
      value = 1000000 + randInt(0, 500000);
    } else {
      value = randInt(10000, 250000);
    }
    return { name, value };
  });

  // --- recent_items: 20 rows ---
  const itemNames = [
    'Widget Alpha', 'Widget Beta', 'Service Plan Pro', 'Connector X',
    'Analytics Module', 'Dashboard Kit', 'API Gateway', 'Data Pipeline',
    'Auth Service', 'Monitoring Tool', 'Report Builder', 'Scheduler',
    'Notification Hub', 'Storage Addon', 'Security Suite', 'Migration Tool',
    'Billing Engine', 'Search Index', 'CDN Accelerator', 'Backup Agent'
  ];
  const recentItems = [];
  for (let i = 0; i < 20; i++) {
    const createdAt = new Date(baseDate);
    createdAt.setDate(createdAt.getDate() + randInt(0, 29));
    createdAt.setHours(randInt(0, 23), randInt(0, 59), randInt(0, 59));
    recentItems.push({
      name: itemNames[i],
      category: categoryNames[randInt(0, categoryNames.length - 1)],
      value: randInt(100, 99999),
      created_at: createdAt.toISOString()
    });
  }

  return { dailyMetrics, categories, recentItems };
}

module.exports = { generateSeedData };
