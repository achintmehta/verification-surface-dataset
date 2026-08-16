/**
 * Seed script: creates test events for the current week to verify
 * overlap layout, geometry, and edge cases.
 *
 * Run: node server/seed.js
 */
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data', 'pglite');

const db = new PGlite(DATA_DIR);

// Get Monday of current week
function getMonday(d = new Date()) {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setDate(d.getDate() + diff);
  mon.setHours(0, 0, 0, 0);
  return mon;
}

function dt(base, dayOffset, h, m = 0) {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

const mon = getMonday();

const events = [
  // Monday: 3 identical-time events (should render as 3 equal columns)
  { title: 'Team Standup A', start_at: dt(mon, 0, 9, 0),  end_at: dt(mon, 0, 10, 0) },
  { title: 'Team Standup B', start_at: dt(mon, 0, 9, 0),  end_at: dt(mon, 0, 10, 0) },
  { title: 'Team Standup C', start_at: dt(mon, 0, 9, 0),  end_at: dt(mon, 0, 10, 0) },

  // Monday: non-overlapping event after the cluster (should use full width)
  { title: 'Lunch',          start_at: dt(mon, 0, 12, 0), end_at: dt(mon, 0, 13, 0) },

  // Tuesday: partial overlap chain: 09:00–11:00, 10:00–12:00, 11:30–13:00
  { title: 'Meeting Alpha',  start_at: dt(mon, 1, 9, 0),  end_at: dt(mon, 1, 11, 0) },
  { title: 'Meeting Beta',   start_at: dt(mon, 1, 10, 0), end_at: dt(mon, 1, 12, 0) },
  { title: 'Meeting Gamma',  start_at: dt(mon, 1, 11, 30),end_at: dt(mon, 1, 13, 0) },

  // Wednesday: event spanning 09:00–10:30 (1.5 hours = 90px)
  { title: 'Workshop',       start_at: dt(mon, 2, 9, 0),  end_at: dt(mon, 2, 10, 30) },

  // Wednesday: event ending at midnight (24:00 = next day 00:00)
  { title: 'Late Night',     start_at: dt(mon, 2, 22, 0), end_at: dt(mon, 3, 0, 0) },

  // Thursday: two overlapping events
  { title: 'Design Review',  start_at: dt(mon, 3, 14, 0), end_at: dt(mon, 3, 16, 0) },
  { title: 'Code Review',    start_at: dt(mon, 3, 15, 0), end_at: dt(mon, 3, 17, 0) },

  // Friday: single event (full width)
  { title: 'Sprint Planning',start_at: dt(mon, 4, 10, 0), end_at: dt(mon, 4, 12, 0) },

  // Saturday: event at midnight start
  { title: 'Early Bird',     start_at: dt(mon, 5, 0, 0),  end_at: dt(mon, 5, 1, 0) },
];

await db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id        SERIAL PRIMARY KEY,
    title     TEXT        NOT NULL,
    start_at  TIMESTAMP   NOT NULL,
    end_at    TIMESTAMP   NOT NULL,
    CONSTRAINT end_after_start CHECK (end_at > start_at)
  );
`);

// Clear existing events
await db.exec('DELETE FROM events');

for (const evt of events) {
  await db.query(
    'INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)',
    [evt.title, evt.start_at, evt.end_at]
  );
  console.log(`Inserted: ${evt.title} (${evt.start_at} → ${evt.end_at})`);
}

console.log(`\nSeeded ${events.length} events.`);
process.exit(0);
