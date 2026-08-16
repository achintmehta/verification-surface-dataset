// Black-box concurrency / correctness tests against a running server.
// Spawns the server on a temp DB and exercises the acceptance criteria.

import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PORT = 4567;
const BASE = `http://localhost:${PORT}`;
const HOLD_TTL_MS = 2000;

let serverProc;
let dbDir;
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓', msg); }
  else { failed++; console.error('  ✗', msg); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  let body = null;
  try { body = await res.json(); } catch (_) {}
  return { status: res.status, body };
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return;
    } catch (_) {}
    await sleep(100);
  }
  throw new Error('server did not start');
}

async function inventory() {
  return (await api('/api/inventory')).body;
}

async function checkBalance(label) {
  const inv = await inventory();
  assert(
    inv.available + inv.held + inv.booked === inv.total,
    `${label}: inventory balances (a=${inv.available} h=${inv.held} b=${inv.booked} = ${inv.total})`
  );
  return inv;
}

async function run() {
  dbDir = mkdtempSync(join(tmpdir(), 'seatdb-'));
  serverProc = spawn('node', ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), HOLD_TTL_MS: String(HOLD_TTL_MS), DB_DIR: dbDir, SWEEP_INTERVAL_MS: '500' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));

  await waitForServer();

  // --- Test 1: concurrent holds on the same seat — exactly one wins --------
  console.log('\nTest 1: concurrent holds for the same seat');
  {
    const seatId = 'A1';
    const N = 40;
    const reqs = Array.from({ length: N }, (_, i) =>
      api('/api/holds', {
        method: 'POST',
        body: JSON.stringify({ seatIds: [seatId], sessionId: `sess-${i}` })
      })
    );
    const results = await Promise.all(reqs);
    const wins = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    assert(wins.length === 1, `exactly one of ${N} concurrent holds succeeded (got ${wins.length})`);
    assert(conflicts.length === N - 1, `the other ${N - 1} got 409 conflict`);
    await checkBalance('after concurrent holds');
    // release the winner for later tests
    if (wins[0]) await api(`/api/holds/${wins[0].body.hold.id}`, { method: 'DELETE', body: JSON.stringify({ sessionId: 'x' }) });
  }

  // --- Test 2: all-or-nothing multi-seat hold ------------------------------
  console.log('\nTest 2: all-or-nothing multi-seat acquisition');
  {
    const h1 = await api('/api/holds', { method: 'POST', body: JSON.stringify({ seatIds: ['B1', 'B2'], sessionId: 'u1' }) });
    assert(h1.status === 201, 'first hold of B1,B2 succeeds');
    const h2 = await api('/api/holds', { method: 'POST', body: JSON.stringify({ seatIds: ['B2', 'B3'], sessionId: 'u2' }) });
    assert(h2.status === 409, 'overlapping hold B2,B3 rejected with 409');
    assert(h2.body.conflicts.includes('B2'), 'conflict reports B2');
    const seats = (await api('/api/seats')).body.seats;
    const b3 = seats.find((s) => s.id === 'B3');
    assert(b3.status === 'available', 'B3 was NOT taken (all-or-nothing)');
    await api(`/api/holds/${h1.body.hold.id}`, { method: 'DELETE', body: JSON.stringify({ sessionId: 'u1' }) });
  }

  // --- Test 3: confirm books seats, idempotently ---------------------------
  console.log('\nTest 3: idempotent confirmation');
  {
    const h = await api('/api/holds', { method: 'POST', body: JSON.stringify({ seatIds: ['C1', 'C2'], sessionId: 'buyer' }) });
    assert(h.status === 201, 'hold C1,C2 created');
    const c1 = await api(`/api/holds/${h.body.hold.id}/confirm`, { method: 'POST', body: JSON.stringify({ sessionId: 'buyer' }) });
    assert(c1.status === 200 && c1.body.booking.seatIds.length === 2, 'confirm books 2 seats');
    const c2 = await api(`/api/holds/${h.body.hold.id}/confirm`, { method: 'POST', body: JSON.stringify({ sessionId: 'buyer' }) });
    assert(c2.status === 200 && c2.body.alreadyConfirmed === true, 'second confirm is idempotent');
    assert(c2.body.booking.seatIds.sort().join() === c1.body.booking.seatIds.sort().join(), 'same seats returned');
    const inv = await checkBalance('after booking');
    assert(inv.booked === 2, 'exactly 2 seats booked total');
  }

  // --- Test 3b: concurrent confirms only book once -------------------------
  console.log('\nTest 3b: concurrent confirms of same hold');
  {
    const h = await api('/api/holds', { method: 'POST', body: JSON.stringify({ seatIds: ['C5'], sessionId: 'rapid' }) });
    const confirms = await Promise.all(
      Array.from({ length: 10 }, () =>
        api(`/api/holds/${h.body.hold.id}/confirm`, { method: 'POST', body: JSON.stringify({ sessionId: 'rapid' }) })
      )
    );
    const ok = confirms.filter((r) => r.status === 200);
    assert(ok.length === 10, 'all 10 concurrent confirms returned 200');
    const seats = (await api('/api/seats')).body.seats;
    const c5 = seats.find((s) => s.id === 'C5');
    assert(c5.status === 'booked', 'C5 booked exactly once');
  }

  // --- Test 4: expiry frees seats automatically ----------------------------
  console.log('\nTest 4: hold expiry auto-releases');
  {
    const h = await api('/api/holds', { method: 'POST', body: JSON.stringify({ seatIds: ['D1'], sessionId: 'forgetful' }) });
    assert(h.status === 201, 'hold D1 created');
    let seats = (await api('/api/seats')).body.seats;
    assert(seats.find((s) => s.id === 'D1').status === 'held', 'D1 is held');
    await sleep(HOLD_TTL_MS + 800); // wait past TTL (+ sweep)
    seats = (await api('/api/seats')).body.seats;
    assert(seats.find((s) => s.id === 'D1').status === 'available', 'D1 auto-released after TTL');

    // confirming the expired hold must fail and book nothing
    const c = await api(`/api/holds/${h.body.hold.id}/confirm`, { method: 'POST', body: JSON.stringify({ sessionId: 'forgetful' }) });
    assert(c.status === 409, 'confirming expired hold returns 409');
    seats = (await api('/api/seats')).body.seats;
    assert(seats.find((s) => s.id === 'D1').status === 'available', 'D1 still available (nothing booked)');
  }

  // --- Test 5: unknown hold confirm fails ----------------------------------
  console.log('\nTest 5: unknown hold');
  {
    const c = await api('/api/holds/does-not-exist/confirm', { method: 'POST', body: JSON.stringify({ sessionId: 'z' }) });
    assert(c.status === 404, 'confirming unknown hold returns 404');
  }

  // --- Test 6: SSE broadcasts a transition ---------------------------------
  console.log('\nTest 6: SSE broadcast on hold');
  {
    const got = await new Promise(async (resolve) => {
      const res = await fetch(BASE + '/api/stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const timeout = setTimeout(() => { reader.cancel(); resolve(null); }, 4000);
      // trigger a change shortly after connecting
      setTimeout(() => {
        api('/api/holds', { method: 'POST', body: JSON.stringify({ seatIds: ['E9'], sessionId: 'sse-test' }) });
      }, 200);
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes('"reason":"held"') && buf.includes('E9')) {
          clearTimeout(timeout);
          reader.cancel();
          resolve(true);
          break;
        }
      }
    });
    assert(got === true, 'received SSE seat-update for E9 hold');
  }

  // --- Test 7: final balance -----------------------------------------------
  console.log('\nTest 7: final inventory consistency');
  await checkBalance('final');

  console.log(`\n${passed} passed, ${failed} failed`);
}

async function main() {
  try {
    await run();
  } catch (err) {
    console.error('TEST HARNESS ERROR', err);
    failed++;
  } finally {
    if (serverProc) serverProc.kill('SIGKILL');
    if (dbDir) try { rmSync(dbDir, { recursive: true, force: true }); } catch (_) {}
    process.exit(failed > 0 ? 1 : 0);
  }
}

main();
