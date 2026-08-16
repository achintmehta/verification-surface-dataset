const BASE = 'http://localhost:3001';
const events = [];

// Open an SSE connection using fetch streaming.
const ctrl = new AbortController();
const res = await fetch(BASE + '/api/stream', { signal: ctrl.signal });
const reader = res.body.getReader();
const dec = new TextDecoder();
(async () => {
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = /event: (\w+)/.exec(chunk);
      if (ev) events.push(ev[1]);
    }
  }
})().catch(() => {});

await new Promise(r => setTimeout(r, 300));

async function post(p, b) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return r.json().catch(() => null);
}

const hold = await post('/api/holds', { seatIds: ['E9'], sessionId: 'sse-test' });
await post(`/api/holds/${hold.hold.id}/confirm`);
await new Promise(r => setTimeout(r, 400));

ctrl.abort();

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n)); };
console.log('[sse] broadcasts received:', events);
check('got connected', events.includes('connected'));
check('got held broadcast', events.includes('held'));
check('got booked broadcast', events.includes('booked'));
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
