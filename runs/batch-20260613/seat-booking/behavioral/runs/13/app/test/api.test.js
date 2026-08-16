// HTTP-level integration tests for the seat-booking API.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../server/index.js';

let server;
let base;

before(async () => {
  process.env.HOLD_TTL_MS = '400'; // short TTL so expiry tests are fast
  const { app, stop } = await createServer({ dataDir: undefined });
  server = { stop };
  const listener = await new Promise((resolve) => {
    const l = app.listen(0, () => resolve(l));
  });
  server.listener = listener;
  const { port } = listener.address();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((r) => server.listener.close(r));
  await server.stop();
});

async function json(path, opts) {
  const res = await fetch(base + path, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

test('GET /api/seats returns the full seat map', async () => {
  const { status, body } = await json('/api/seats');
  assert.equal(status, 200);
  assert.equal(body.seats.length, 50);
  assert.ok(body.seats.every((s) => s.status === 'available'));
});

test('hold -> confirm flow over HTTP', async () => {
  const hold = await json('/api/holds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds: ['A1', 'A2'], sessionId: 'http-1' }),
  });
  assert.equal(hold.status, 201);
  const holdId = hold.body.hold.id;

  const confirm = await json(`/api/holds/${holdId}/confirm`, { method: 'POST' });
  assert.equal(confirm.status, 200);
  assert.deepEqual(confirm.body.booking.seatIds.sort(), ['A1', 'A2']);

  // idempotent
  const confirm2 = await json(`/api/holds/${holdId}/confirm`, { method: 'POST' });
  assert.equal(confirm2.status, 200);
  assert.deepEqual(confirm2.body.booking.seatIds.sort(), ['A1', 'A2']);
});

test('conflicting hold returns 409 with conflict ids', async () => {
  await json('/api/holds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds: ['B1'], sessionId: 'owner' }),
  });
  const conflict = await json('/api/holds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds: ['B1', 'B2'], sessionId: 'other' }),
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body.conflicts, ['B1']);

  // all-or-nothing: B2 still available
  const seats = (await json('/api/seats')).body.seats;
  assert.equal(seats.find((s) => s.id === 'B2').status, 'available');
});

test('expired hold cannot be confirmed (over HTTP)', async () => {
  const hold = await json('/api/holds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds: ['C1'], sessionId: 'slow' }),
  });
  const holdId = hold.body.hold.id;

  await new Promise((r) => setTimeout(r, 600)); // exceed the 400ms TTL

  const confirm = await json(`/api/holds/${holdId}/confirm`, { method: 'POST' });
  assert.equal(confirm.status, 409);

  const seat = (await json('/api/seats')).body.seats.find((s) => s.id === 'C1');
  assert.equal(seat.status, 'available');
});

test('release returns seats to available (over HTTP)', async () => {
  const hold = await json('/api/holds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds: ['D1', 'D2'], sessionId: 'rel' }),
  });
  const holdId = hold.body.hold.id;
  const del = await json(`/api/holds/${holdId}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(del.body.released.sort(), ['D1', 'D2']);

  const seats = (await json('/api/seats')).body.seats;
  assert.ok(['D1', 'D2'].every((id) => seats.find((s) => s.id === id).status === 'available'));
});

test('inventory always reconciles', async () => {
  const inv = (await json('/api/inventory')).body;
  assert.equal(inv.available + inv.held + inv.booked, inv.total);
  assert.equal(inv.total, 50);
});
