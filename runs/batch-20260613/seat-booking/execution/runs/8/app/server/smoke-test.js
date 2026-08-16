// Optional smoke/concurrency test. Start the server first, then run: npm run test:smoke
const API = process.env.API_BASE || 'http://localhost:3000';

async function json(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

const seatId = process.env.SMOKE_SEAT || 'A1';
const attempts = Array.from({ length: 10 }, (_, i) =>
  json('/api/holds', {
    method: 'POST',
    body: JSON.stringify({ seatIds: [seatId], sessionId: `smoke-${Date.now()}-${i}` }),
  })
);
const results = await Promise.all(attempts);
const successes = results.filter(({ res }) => res.status === 201);
const conflicts = results.filter(({ res }) => res.status === 409);
console.log({ seatId, successes: successes.length, conflicts: conflicts.length });
if (successes.length !== 1) {
  console.error(results.map((r) => ({ status: r.res.status, body: r.body })));
  process.exit(1);
}
await json(`/api/holds/${successes[0].body.hold.id}`, {
  method: 'DELETE',
  body: JSON.stringify({ sessionId: successes[0].body.hold.sessionId }),
});
console.log('Smoke test passed');
