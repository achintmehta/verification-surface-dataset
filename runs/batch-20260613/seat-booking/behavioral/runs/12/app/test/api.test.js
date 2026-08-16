import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { initDb } from '../server/db.js';
import { createServer } from '../server/index.js';

async function startApp(ttlMs = 60000) {
  const db = await initDb('memory://');
  const { app, stopSweep } = await createServer({ db, ttlMs, startSweep: false });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    close: () =>
      new Promise((resolve) => {
        stopSweep();
        server.close(resolve);
      }),
  };
}

async function json(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test('GET /api/seats returns the seat map', async () => {
  const { base, close } = await startApp();
  try {
    const { status, data } = await json('GET', `${base}/api/seats`);
    assert.equal(status, 200);
    assert.equal(data.seats.length, 50);
    assert.equal(data.summary.available, 50);
    assert.ok(data.holdTtlMs > 0);
  } finally {
    await close();
  }
});

test('hold -> confirm flow over HTTP', async () => {
  const { base, close } = await startApp();
  try {
    const hold = await json('POST', `${base}/api/holds`, {
      seatIds: ['A1', 'A2'],
      sessionId: 's1',
    });
    assert.equal(hold.status, 201);
    const holdId = hold.data.hold.id;

    const confirm = await json('POST', `${base}/api/holds/${holdId}/confirm`, {
      sessionId: 's1',
    });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.data.alreadyConfirmed, false);
    for (const s of confirm.data.seats) assert.equal(s.status, 'booked');
  } finally {
    await close();
  }
});

test('hold conflict returns 409 with conflicting seat ids', async () => {
  const { base, close } = await startApp();
  try {
    await json('POST', `${base}/api/holds`, { seatIds: ['B1'], sessionId: 's1' });
    const second = await json('POST', `${base}/api/holds`, {
      seatIds: ['B1', 'B2'],
      sessionId: 's2',
    });
    assert.equal(second.status, 409);
    assert.deepEqual(second.data.conflictingSeatIds, ['B1']);
    // B2 must remain available.
    const seats = await json('GET', `${base}/api/seats`);
    const b2 = seats.data.seats.find((s) => s.id === 'B2');
    assert.equal(b2.status, 'available');
  } finally {
    await close();
  }
});

test('DELETE /api/holds/:id releases a hold', async () => {
  const { base, close } = await startApp();
  try {
    const hold = await json('POST', `${base}/api/holds`, {
      seatIds: ['C1'],
      sessionId: 's1',
    });
    const del = await json('DELETE', `${base}/api/holds/${hold.data.hold.id}`, {
      sessionId: 's1',
    });
    assert.equal(del.status, 200);
    assert.equal(del.data.seats[0].status, 'available');
  } finally {
    await close();
  }
});

test('SSE stream delivers a seats event on a hold', async () => {
  const { base, close } = await startApp();
  try {
    const received = new Promise((resolve, reject) => {
      const req = http.get(`${base}/api/stream`, (res) => {
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString();
          if (buf.includes('event: seats')) {
            req.destroy();
            resolve(buf);
          }
        });
        res.on('error', reject);
      });
      req.on('error', () => {}); // ignore destroy-induced error
      setTimeout(() => reject(new Error('timeout waiting for SSE')), 3000);
    });

    // Give the stream a moment to register, then trigger a transition.
    await new Promise((r) => setTimeout(r, 100));
    await json('POST', `${base}/api/holds`, { seatIds: ['D1'], sessionId: 's1' });

    const payload = await received;
    assert.ok(payload.includes('event: seats'));
    assert.ok(payload.includes('"reason":"held"'));
    assert.ok(payload.includes('D1'));
  } finally {
    await close();
  }
});
