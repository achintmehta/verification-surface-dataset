const BASE = 'http://localhost:3001';

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function del(path) {
  const res = await fetch(BASE + path, { method: 'DELETE' });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function get(path) {
  const res = await fetch(BASE + path);
  return { status: res.status, body: await res.json().catch(() => null) };
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

// 1. Concurrent holds for same seat: exactly one wins.
console.log('\n[1] Concurrent holds for same seat (C1)');
{
  const N = 30;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      post('/api/holds', { seatIds: ['C1'], sessionId: 'sess-' + i })
    )
  );
  const wins = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409);
  check('exactly one hold succeeds', wins.length === 1);
  check('rest are 409', conflicts.length === N - 1);
  check('conflicts list C1', conflicts.every((c) => c.body.conflicts.includes('C1')));
}

// 2. Active hold blocks others, then confirm idempotency.
console.log('\n[2] Hold + idempotent confirm');
{
  const hold = await post('/api/holds', { seatIds: ['D1', 'D2'], sessionId: 'alice' });
  check('hold created', hold.status === 201);
  const holdId = hold.body.hold.id;

  // Another user cannot hold D1.
  const blocked = await post('/api/holds', { seatIds: ['D1'], sessionId: 'bob' });
  check('other user blocked', blocked.status === 409 && blocked.body.conflicts.includes('D1'));

  const c1 = await post(`/api/holds/${holdId}/confirm`);
  const c2 = await post(`/api/holds/${holdId}/confirm`);
  check('first confirm ok', c1.status === 200);
  check('second confirm ok (idempotent)', c2.status === 200);
  check('same seats both times',
    JSON.stringify(c1.body.booking.seatIds.sort()) === JSON.stringify(c2.body.booking.seatIds.sort()));
  check('second flagged idempotent', c2.body.idempotent === true);

  // Booked seats cannot be held.
  const afterBook = await post('/api/holds', { seatIds: ['D1'], sessionId: 'carol' });
  check('booked seat cannot be held', afterBook.status === 409);
}

// 3. Release returns seats.
console.log('\n[3] Release returns seats to available');
{
  const hold = await post('/api/holds', { seatIds: ['E5'], sessionId: 'dave' });
  const holdId = hold.body.hold.id;
  await del(`/api/holds/${holdId}`);
  const seats = (await get('/api/seats')).body.seats;
  const e5 = seats.find((s) => s.id === 'E5');
  check('E5 available after release', e5.status === 'available');
  // Confirm a released hold fails.
  const conf = await post(`/api/holds/${holdId}/confirm`);
  check('confirm released hold fails', conf.status === 409);
}

// 4. Unknown hold confirm fails.
console.log('\n[4] Unknown hold');
{
  const conf = await post('/api/holds/does-not-exist/confirm');
  check('unknown hold confirm fails', conf.status === 409);
}

// 5. Inventory always balances.
console.log('\n[5] Inventory balances');
{
  const inv = (await get('/api/inventory')).body;
  check('available+held+booked == total',
    inv.available + inv.held + inv.booked === inv.total);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
