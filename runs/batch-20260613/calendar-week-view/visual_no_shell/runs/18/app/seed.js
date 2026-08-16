const http = require('http');

const events = [
  { title: 'Event 1', start_at: '2026-06-15T09:00:00Z', end_at: '2026-06-15T11:00:00Z' },
  { title: 'Event 2', start_at: '2026-06-15T10:00:00Z', end_at: '2026-06-15T12:00:00Z' },
  { title: 'Event 3', start_at: '2026-06-15T11:30:00Z', end_at: '2026-06-15T13:00:00Z' },
  { title: 'Event 4', start_at: '2026-06-15T14:00:00Z', end_at: '2026-06-15T15:00:00Z' },
  { title: 'Event 5', start_at: '2026-06-16T09:00:00Z', end_at: '2026-06-16T10:00:00Z' },
  { title: 'Event 6', start_at: '2026-06-16T09:00:00Z', end_at: '2026-06-16T10:00:00Z' },
  { title: 'Event 7', start_at: '2026-06-16T09:00:00Z', end_at: '2026-06-16T10:00:00Z' },
  { title: 'Event 8', start_at: '2026-06-17T23:00:00Z', end_at: '2026-06-18T01:00:00Z' }
];

function postEvent(event) {
  return new Promise((resolve, reject) => {
    const req = http.request('http://localhost:3000/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(JSON.stringify(event));
    req.end();
  });
}

async function run() {
  for (const ev of events) {
    await postEvent(ev);
  }
  console.log('Done');
}

run();
