// Seed deterministic events into the CURRENT local week to exercise the
// overlap layout. Run with: node server/seed.js
const base = 'http://localhost:3001';

function startOfWeek(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day);
  date.setHours(0, 0, 0, 0);
  return date;
}
function at(dayOffset, h, m = 0) {
  const ws = startOfWeek(new Date());
  const d = new Date(ws);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

const events = [
  // Monday: three identical-range events -> three equal columns
  { title: 'Standup A', start_at: at(0, 9), end_at: at(0, 10) },
  { title: 'Standup B', start_at: at(0, 9), end_at: at(0, 10) },
  { title: 'Standup C', start_at: at(0, 9), end_at: at(0, 10) },
  // Monday later: non-overlapping full width event after the cluster
  { title: 'Lunch (full width)', start_at: at(0, 12), end_at: at(0, 13) },

  // Tuesday: partially overlapping chain
  { title: 'Chain 1', start_at: at(1, 9), end_at: at(1, 11) },
  { title: 'Chain 2', start_at: at(1, 10), end_at: at(1, 12) },
  { title: 'Chain 3', start_at: at(1, 11, 30), end_at: at(1, 13) },

  // Wednesday: single full-width event with minute precision
  { title: 'Design review', start_at: at(2, 9), end_at: at(2, 10, 30) },

  // Thursday: event ending exactly at midnight (24:00)
  { title: 'Late shift', start_at: at(3, 22), end_at: at(4, 0) },

  // Friday: two overlapping + one independent later
  { title: 'Meet X', start_at: at(4, 14), end_at: at(4, 16) },
  { title: 'Meet Y', start_at: at(4, 15), end_at: at(4, 17) },
  { title: 'Solo eve', start_at: at(4, 18), end_at: at(4, 19) },
];

for (const ev of events) {
  const res = await fetch(`${base}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ev)
  });
  console.log(res.status, ev.title);
}
