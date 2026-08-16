const http = require('http');

const events = [
  { title: 'Event 1', start_at: '2026-06-15T09:00:00Z', end_at: '2026-06-15T10:30:00Z' },
  { title: 'Event 2', start_at: '2026-06-15T10:00:00Z', end_at: '2026-06-15T11:30:00Z' },
  { title: 'Event 3', start_at: '2026-06-15T11:00:00Z', end_at: '2026-06-15T12:30:00Z' },
  { title: 'Event 4', start_at: '2026-06-16T14:00:00Z', end_at: '2026-06-16T16:00:00Z' },
  { title: 'Event 5', start_at: '2026-06-16T14:30:00Z', end_at: '2026-06-16T15:30:00Z' },
  { title: 'Event 6', start_at: '2026-06-16T15:00:00Z', end_at: '2026-06-16T17:00:00Z' },
  { title: 'Event 7', start_at: '2026-06-17T08:00:00Z', end_at: '2026-06-17T09:00:00Z' },
  { title: 'Event 8', start_at: '2026-06-17T08:00:00Z', end_at: '2026-06-17T09:00:00Z' },
  { title: 'Event 9', start_at: '2026-06-17T08:00:00Z', end_at: '2026-06-17T09:00:00Z' },
  { title: 'Event 10', start_at: '2026-06-18T23:00:00Z', end_at: '2026-06-19T01:00:00Z' }
];

async function createEvents() {
  for (const ev of events) {
    const data = JSON.stringify(ev);
    const req = http.request({
      hostname: 'localhost',
      port: 3001,
      path: '/api/events',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    }, res => {
      res.on('data', d => process.stdout.write(d));
    });
    req.write(data);
    req.end();
    await new Promise(r => setTimeout(r, 100));
  }
}

createEvents();