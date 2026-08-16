// Dev-only seeding helper. Runs when SEED=1. Inserts demo events into the
// current week to visually verify the overlap layout, then is a no-op on reruns.
import { getDb } from './db.js';

function atToday(weekStartMonday, dayOffset, h, m) {
  const d = new Date(weekStartMonday);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = (day + 6) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}

export async function seed() {
  const db = await getDb();
  const existing = await db.query('SELECT COUNT(*)::int AS c FROM events');
  if (existing.rows[0].c > 0) {
    console.log('Seed skipped: events already present');
    return;
  }
  const wk = startOfWeek(new Date());
  const rows = [
    // Mon: three identical 09:00-10:00 events (N equal columns)
    ['Standup A', atToday(wk, 0, 9, 0), atToday(wk, 0, 10, 0)],
    ['Standup B', atToday(wk, 0, 9, 0), atToday(wk, 0, 10, 0)],
    ['Standup C', atToday(wk, 0, 9, 0), atToday(wk, 0, 10, 0)],
    // Mon later: a non-overlapping event uses full width
    ['Solo lunch', atToday(wk, 0, 12, 30), atToday(wk, 0, 13, 30)],
    // Tue: partially overlapping chain
    ['Chain 1', atToday(wk, 1, 9, 0), atToday(wk, 1, 11, 0)],
    ['Chain 2', atToday(wk, 1, 10, 0), atToday(wk, 1, 12, 0)],
    ['Chain 3', atToday(wk, 1, 11, 30), atToday(wk, 1, 13, 0)],
    // Wed: precise 09:00-10:30 (1.5 rows) and a full-day-ending event
    ['Review', atToday(wk, 2, 9, 0), atToday(wk, 2, 10, 30)],
    ['Night shift', atToday(wk, 2, 22, 0), atToday(wk, 2, 24, 0)],
  ];
  for (const [title, start, end] of rows) {
    await db.query(
      'INSERT INTO events (title, start_at, end_at) VALUES ($1,$2,$3)',
      [title, start, end]
    );
  }
  console.log(`Seeded ${rows.length} events`);
}
