// Concurrency / correctness test harness. Boots the server with a temp data dir
// and a short TTL, then exercises the acceptance criteria.
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const TTL = 2000; // 2s for fast expiry test
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-test-'));

let serverProc;
let failures = 0;
const results = [];

function assert(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/seats`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not start in time');
}

function startServer() {
  serverProc = spawn('node', ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), PGLITE_DIR: dataDir, HOLD_TTL_MS: String(TTL) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
}

async function getSeats() {
  const r = await fetch(`${BASE}/api/seats`);
  return r.json();
}

async function hold(seatIds, sessionId) {
  const r = await fetch(`${BASE}/api/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds, sessionId }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function confirm(holdId, sessionId) {
  const r = await fetch(`${BASE}/api/holds/${holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function release(holdId, sessionId) {
  const r = await fetch(`${BASE}/api/holds/${holdId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

function inventoryBalances(seats, total) {
  const c = { available: 0, held: 0, booked: 0 };
  for (const s of seats) c[s.status]++;
  return c.available + c.held + c.booked === total;
}

async function run() {
  startServer();
  await waitForServer();

  // --- Test 1: concurrent holds for the same seat — exactly one wins ---
  {
    const seat = 'A1';
    const N = 40;
    const reqs = [];
    for (let i = 0; i < N; i++) reqs.push(hold([seat], 'sess-' + i));
    const res = await Promise.all(reqs);
    const wins = res.filter((r) => r.status === 201);
    const conflicts = res.filter((r) => r.status === 409);
    assert('Concurrent holds: exactly one wins', wins.length === 1, `${wins.length} winners`);
    assert('Concurrent holds: rest are 409', conflicts.length === N - 1, `${conflicts.length} conflicts`);
    // release the winner for later tests
    if (wins.length === 1) await release(wins[0].body.hold.id, wins[0].body.hold.sessionId);
  }

  // --- Test 2: all-or-nothing hold ---
  {
    await hold(['B1'], 'owner'); // hold B1
    const r = await hold(['B1', 'B2', 'B3'], 'other'); // should fail entirely
    assert('All-or-nothing: multi-seat hold with one taken -> 409', r.status === 409);
    const seats = (await getSeats()).seats;
    const b2 = seats.find((s) => s.id === 'B2');
    const b3 = seats.find((s) => s.id === 'B3');
    assert('All-or-nothing: B2 untouched', b2.status === 'available');
    assert('All-or-nothing: B3 untouched', b3.status === 'available');
  }

  // --- Test 3: confirm books seats; idempotent ---
  {
    const h = await hold(['C1', 'C2'], 'buyer');
    assert('Hold C1,C2 ok', h.status === 201);
    const hid = h.body.hold.id;
    const c1 = await confirm(hid, 'buyer');
    assert('Confirm succeeds', c1.status === 200 && c1.body.booking.seatIds.length === 2);
    const c2 = await confirm(hid, 'buyer');
    assert('Confirm idempotent (same seats, idempotent flag)',
      c2.status === 200 && c2.body.idempotent === true &&
      c2.body.booking.seatIds.slice().sort().join() === 'C1,C2');
    const seats = (await getSeats()).seats;
    const booked = seats.filter((s) => s.status === 'booked' && (s.id === 'C1' || s.id === 'C2'));
    assert('Exactly two seats booked once', booked.length === 2);
    // cannot hold booked seats
    const reh = await hold(['C1'], 'thief');
    assert('Cannot hold a booked seat', reh.status === 409);
  }

  // --- Test 4: expired hold releases seats; confirm after expiry fails ---
  {
    const h = await hold(['D1', 'D2'], 'slow');
    assert('Hold D1,D2 ok', h.status === 201);
    const hid = h.body.hold.id;
    await new Promise((r) => setTimeout(r, TTL + 600)); // wait past TTL + a tick
    const seats = (await getSeats()).seats; // read triggers lazy expiry
    const d1 = seats.find((s) => s.id === 'D1');
    assert('Expired hold frees seats automatically', d1.status === 'available', `D1=${d1.status}`);
    const c = await confirm(hid, 'slow');
    assert('Confirm after expiry fails', c.status >= 400, `status ${c.status}`);
    const seats2 = (await getSeats()).seats;
    const d1b = seats2.find((s) => s.id === 'D1');
    assert('Confirm after expiry books nothing', d1b.status === 'available');
  }

  // --- Test 5: inventory always balances ---
  {
    const data = await getSeats();
    assert('Inventory balances (avail+held+booked = total)',
      inventoryBalances(data.seats, data.inventory.total) &&
      data.inventory.available + data.inventory.held + data.inventory.booked === data.inventory.total);
  }

  // --- Test 6: active hold blocks others ---
  {
    const h = await hold(['E5'], 'holderX');
    assert('Hold E5 ok', h.status === 201);
    const blocked = await hold(['E5'], 'holderY');
    assert('Active hold blocks others', blocked.status === 409);
    const cf = await confirm(h.body.hold.id, 'holderX');
    assert('Owner can confirm held seat', cf.status === 200);
  }

  // --- Test 7: no seat booked by two sessions, ever (full scan invariant) ---
  {
    // hammer many concurrent holds across overlapping seats then confirm winners
    const targets = ['F1', 'F2', 'F3', 'F4', 'F5'];
    const reqs = [];
    for (let i = 0; i < 30; i++) {
      const pick = targets[i % targets.length];
      reqs.push(hold([pick], 'h' + i).then(async (r) => {
        if (r.status === 201) return confirm(r.body.hold.id, r.body.hold.sessionId);
        return r;
      }));
    }
    await Promise.all(reqs);
    const seats = (await getSeats()).seats;
    const bookedByMap = {};
    let doubleBooked = false;
    for (const s of seats) {
      if (s.status === 'booked') {
        if (bookedByMap[s.id]) doubleBooked = true;
        bookedByMap[s.id] = s.bookedBy;
      }
    }
    assert('No double-booking under concurrency', !doubleBooked);
    assert('Final inventory still balances', inventoryBalances(seats, seats.length));
  }

  console.log(`\n${results.length - failures}/${results.length} checks passed.`);
}

run()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(() => {
    if (serverProc) serverProc.kill('SIGKILL');
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    process.exit(failures > 0 ? 1 : 0);
  });
