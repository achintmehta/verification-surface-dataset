/**
 * Seed script — creates test events for the current week to verify layout.
 * Run with: node seed.js
 */

const BASE = 'http://localhost:3001/api/events';

async function post(data) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error('Failed:', body.error, data);
  } else {
    console.log('Created:', body.id, body.title);
  }
  return body;
}

// Get Monday of current week
function getMonday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return d;
}

function dt(base, dayOffset, h, m) {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

async function seed() {
  const mon = getMonday();
  console.log('Week starting:', mon.toDateString());

  // Monday: single event (full width)
  await post({ title: 'Team Standup', start_at: dt(mon, 0, 9, 0), end_at: dt(mon, 0, 9, 30) });

  // Monday: two overlapping events (side by side)
  await post({ title: 'Design Review', start_at: dt(mon, 0, 10, 0), end_at: dt(mon, 0, 11, 30) });
  await post({ title: 'Sprint Planning', start_at: dt(mon, 0, 10, 0), end_at: dt(mon, 0, 11, 0) });

  // Tuesday: three identical time range events (3 equal columns)
  await post({ title: 'Interview A', start_at: dt(mon, 1, 14, 0), end_at: dt(mon, 1, 15, 0) });
  await post({ title: 'Interview B', start_at: dt(mon, 1, 14, 0), end_at: dt(mon, 1, 15, 0) });
  await post({ title: 'Interview C', start_at: dt(mon, 1, 14, 0), end_at: dt(mon, 1, 15, 0) });

  // Wednesday: chain overlap (09:00-11:00, 10:00-12:00, 11:30-13:00)
  await post({ title: 'Morning Block', start_at: dt(mon, 2, 9, 0),  end_at: dt(mon, 2, 11, 0) });
  await post({ title: 'Mid Block',     start_at: dt(mon, 2, 10, 0), end_at: dt(mon, 2, 12, 0) });
  await post({ title: 'Late Block',    start_at: dt(mon, 2, 11, 30),end_at: dt(mon, 2, 13, 0) });

  // Wednesday: non-overlapping event later in the day (should be full width)
  await post({ title: 'Lunch Meeting', start_at: dt(mon, 2, 13, 30), end_at: dt(mon, 2, 14, 30) });

  // Thursday: event ending at midnight (24:00)
  await post({ title: 'Late Night Work', start_at: dt(mon, 3, 22, 0), end_at: dt(mon, 3, 23, 59) });

  // Friday: event spanning most of the day
  await post({ title: 'All Day Workshop', start_at: dt(mon, 4, 8, 0), end_at: dt(mon, 4, 17, 0) });

  // Saturday: short event
  await post({ title: 'Weekend Errand', start_at: dt(mon, 5, 10, 0), end_at: dt(mon, 5, 10, 30) });

  console.log('Seeding complete!');
}

seed().catch(console.error);
