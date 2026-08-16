const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const dbPath = path.join(__dirname, 'backend', 'pglite-data');
const db = new PGlite(dbPath);

async function seed() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      start_at TIMESTAMP NOT NULL,
      end_at TIMESTAMP NOT NULL,
      CONSTRAINT end_after_start CHECK (end_at > start_at)
    );
  `);

  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay() + 1);
  startOfWeek.setHours(0, 0, 0, 0);

  const events = [
    { title: 'Event 1', start: 9, end: 10, dayOffset: 0 },
    { title: 'Event 2', start: 9.5, end: 11, dayOffset: 0 },
    { title: 'Event 3', start: 10, end: 12, dayOffset: 0 },
    { title: 'Event 4', start: 13, end: 14, dayOffset: 0 },
    { title: 'Event 5', start: 13, end: 15, dayOffset: 0 },
    { title: 'Event 6', start: 14, end: 16, dayOffset: 0 },
    { title: 'Event 7', start: 14.5, end: 15.5, dayOffset: 0 },
  ];

  for (const ev of events) {
    const start = new Date(startOfWeek);
    start.setDate(start.getDate() + ev.dayOffset);
    start.setHours(Math.floor(ev.start), (ev.start % 1) * 60, 0, 0);

    const end = new Date(startOfWeek);
    end.setDate(end.getDate() + ev.dayOffset);
    end.setHours(Math.floor(ev.end), (ev.end % 1) * 60, 0, 0);

    await db.query(
      `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)`,
      [ev.title, start.toISOString(), end.toISOString()]
    );
  }
  console.log('Seeded');
}

seed().catch(console.error);
