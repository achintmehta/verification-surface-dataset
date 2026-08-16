// Run with: HOLD_TTL_MS=2000 node server/index.js  (separate short-TTL server)
const BASE = 'http://localhost:3002';
async function post(p, b) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function get(p) { const r = await fetch(BASE + p); return { status: r.status, body: await r.json().catch(() => null) }; }

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n)); };

console.log('[expiry] hold expires and seat returns to available');
const hold = await post('/api/holds', { seatIds: ['A1'], sessionId: 'x' });
check('held', hold.status === 201);
let seats = (await get('/api/seats')).body.seats;
check('A1 held now', seats.find(s => s.id === 'A1').status === 'held');

await new Promise(r => setTimeout(r, 3500)); // wait past TTL + sweep

seats = (await get('/api/seats')).body.seats;
check('A1 available after expiry', seats.find(s => s.id === 'A1').status === 'available');

const conf = await post(`/api/holds/${hold.body.hold.id}/confirm`);
check('confirm expired hold fails', conf.status === 409);

const inv = (await get('/api/inventory')).body;
check('inventory balances', inv.available + inv.held + inv.booked === inv.total);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
