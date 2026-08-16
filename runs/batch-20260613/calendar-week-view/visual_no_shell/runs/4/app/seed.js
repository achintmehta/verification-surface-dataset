// Seed script to create test events
// Run via: node seed.js

const BASE = 'http://localhost:3001/api';

async function post(event) {
  const res = await fetch(`${BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('Failed:', data);
  } else {
    console.log('Created:', data.id, data.title);
  }
  return data;
}

// Get today's date (Thursday June 18, 2026 based on screenshot)
const today = '2026-06-18';
const mon = '2026-06-15';
const tue = '2026-06-16';
const wed = '2026-06-17';
const fri = '2026-06-19';

async function seed() {
  // Monday: single event (full width)
  await post({ title: 'Team Standup', start_at: `${mon}T09:00:00`, end_at: `${mon}T09:30:00` });

  // Monday: two overlapping events (side by side)
  await post({ title: 'Design Review', start_at: `${mon}T10:00:00`, end_at: `${mon}T11:30:00` });
  await post({ title: 'Sprint Planning', start_at: `${mon}T10:00:00`, end_at: `${mon}T11:30:00` });

  // Tuesday: three overlapping events (three equal columns)
  await post({ title: 'Meeting A', start_at: `${tue}T09:00:00`, end_at: `${tue}T10:00:00` });
  await post({ title: 'Meeting B', start_at: `${tue}T09:00:00`, end_at: `${tue}T10:00:00` });
  await post({ title: 'Meeting C', start_at: `${tue}T09:00:00`, end_at: `${tue}T10:00:00` });

  // Tuesday: after cluster ends, full-width event
  await post({ title: 'Lunch Break', start_at: `${tue}T12:00:00`, end_at: `${tue}T13:00:00` });

  // Wednesday: partially overlapping chain
  // 09:00-11:00, 10:00-12:00, 11:30-13:00
  await post({ title: 'Workshop Part 1', start_at: `${wed}T09:00:00`, end_at: `${wed}T11:00:00` });
  await post({ title: 'Workshop Part 2', start_at: `${wed}T10:00:00`, end_at: `${wed}T12:00:00` });
  await post({ title: 'Workshop Part 3', start_at: `${wed}T11:30:00`, end_at: `${wed}T13:00:00` });

  // Today (Thursday): event ending at 24:00
  await post({ title: 'Late Night Work', start_at: `${today}T22:00:00`, end_at: `${today}T24:00:00` });

  // Today: normal event
  await post({ title: 'Daily Sync', start_at: `${today}T14:00:00`, end_at: `${today}T15:00:00` });

  // Friday: event spanning 09:00-10:30 (1.5 hours = 90px)
  await post({ title: 'Client Call', start_at: `${fri}T09:00:00`, end_at: `${fri}T10:30:00` });

  console.log('Seeding complete!');
}

seed().catch(console.error);
