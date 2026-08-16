// Deterministic seed data generation for the metrics dashboard.
// Uses a fixed-seed mulberry32 PRNG so every boot produces identical data.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 1337;

// A fixed anchor date keeps the seed fully deterministic regardless of when
// the server boots. The 30-day window ends on this date.
const ANCHOR_DATE = new Date(Date.UTC(2024, 5, 30)); // 2024-06-30

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function isoDateTime(d) {
  return d.toISOString();
}

export function buildSeed() {
  const rand = mulberry32(SEED);

  // --- daily_metrics: 30 rows (date, visitors, revenue) ---
  const dailyMetrics = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(ANCHOR_DATE.getTime() - i * 24 * 60 * 60 * 1000);
    // visitors trend upward with noise
    const base = 800 + (29 - i) * 18;
    const visitors = Math.round(base + (rand() - 0.5) * 320);
    const revenue = Math.round(visitors * (4 + rand() * 6) * 100) / 100;
    dailyMetrics.push({
      date: isoDate(d),
      visitors,
      revenue,
    });
  }

  // --- categories: 6 rows, one deliberately long label, one value >= 1,000,000 ---
  const categories = [
    { name: "Enterprise Infrastructure & Compliance", value: 1284390 },
    { name: "Marketing", value: 642100 },
    { name: "Direct Sales", value: 531200 },
    { name: "Partnerships", value: 388750 },
    { name: "Support", value: 211900 },
    { name: "Other", value: 96450 },
  ];

  // --- recent_items: 20 rows (name, category, value, created_at) ---
  const itemNouns = [
    "Order", "Invoice", "Subscription", "Refund", "Upgrade",
    "Renewal", "Trial", "Demo", "Contract", "Quote",
  ];
  const catNames = categories.map((c) => c.name);
  const recentItems = [];
  for (let i = 0; i < 20; i++) {
    const noun = itemNouns[Math.floor(rand() * itemNouns.length)];
    const num = 1000 + Math.floor(rand() * 9000);
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = Math.round((20 + rand() * 9800) * 100) / 100;
    // created_at within the last ~10 days of the anchor window
    const offsetMs = Math.floor(rand() * 10 * 24 * 60 * 60 * 1000);
    const created = new Date(ANCHOR_DATE.getTime() - offsetMs);
    recentItems.push({
      name: `${noun} #${num}`,
      category,
      value,
      created_at: isoDateTime(created),
    });
  }
  // sort recent items by created_at descending (most recent first)
  recentItems.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  return { dailyMetrics, categories, recentItems };
}
