import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDb } from '../server/db.js';
import { createApp } from '../server/app.js';

async function startServer(opts = {}) {
  const db = await createDb();
  const { app, stopSweep } = createApp(db, opts);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    close: () =>
      new Promise((r) => {
        stopSweep();
        server.close(r);
      }),
  };
}

async function jfetch(base, path, opts) {
  const res = await fetch(base + path, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, body };
}

test('GET /api/seats returns the full map', async () => {
  const srv = await startServer();
  try {
    const { status, body } = await jfetch(srv.base, '/api/seats');
    assert.equal(status, 200);
    assert.equal(body.seats.length, 50);
    assert.ok(body.ttlMs > 0);
  } finally {
    await srv.close();
  }
});

test('full hold -> confirm flow over HTTP', async () => {
  const srv = await startServer();
  try {
    const hold = await jfetch(srv.base, '/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: ['A1', 'A2'], sessionId: 's1' }),
    });
    assert.equal(hold.status, 201);
    const holdId = hold.body.holdId;

    const confirm = await jfetch(srv.base, `/api/holds/${holdId}/confirm`, {
      method: 'POST',
    });
    assert.equal(confirm.status, 200);
    assert.deepEqual(confirm.body.seatIds, ['A1', 'A2']);

    // Idempotent second confirm.
    const confirm2 = await jfetch(srv.base, `/api/holds/${holdId}/confirm`, {
      method: 'POST',
    });
    assert.equal(confirm2.status, 200);
    assert.equal(confirm2.body.alreadyConfirmed, true);
  } finally {
    await srv.close();
  }
});

test('409 conflict returns conflicting seat ids', async () => {
  const srv = await startServer();
  try {
    await jfetch(srv.base, '/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: ['B1'], sessionId: 's1' }),
    });
    const conflict = await jfetch(srv.base, '/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: ['B1'], sessionId: 's2' }),
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body.conflicts, ['B1']);
  } finally {
    await srv.close();
  }
});

test('DELETE releases a hold', async () => {
  const srv = await startServer();
  try {
    const hold = await jfetch(srv.base, '/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: ['C1'], sessionId: 's1' }),
    });
    const del = await jfetch(srv.base, `/api/holds/${hold.body.holdId}`, {
      method: 'DELETE',
    });
    assert.equal(del.status, 200);
    assert.deepEqual(del.body.released, ['C1']);
  } finally {
    await srv.close();
  }
});

test('SSE stream broadcasts seat events', async () => {
  const srv = await startServer();
  try {
    const received = [];
    // Open an SSE connection manually.
    const ctrl = new AbortController();
    const streamPromise = (async () => {
      const res = await fetch(srv.base + '/api/stream', { signal: ctrl.signal });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (dataLine) {
            received.push(JSON.parse(dataLine.slice(6)));
          }
        }
      }
    })().catch(() => {});

    // Give the connection a moment to register.
    await new Promise((r) => setTimeout(r, 100));

    await jfetch(srv.base, '/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: ['D1'], sessionId: 's1' }),
    });

    // Wait for the broadcast to arrive.
    await new Promise((r) => setTimeout(r, 200));
    ctrl.abort();
    await streamPromise;

    const heldEvent = received
      .flatMap((m) => m.events)
      .find((e) => e.type === 'held' && e.seatId === 'D1');
    assert.ok(heldEvent, 'expected a held broadcast for D1');
  } finally {
    await srv.close();
  }
});

test('expiry frees seats automatically (HTTP)', async () => {
  const srv = await startServer({ holdTtlMs: 40, sweepIntervalMs: 20 });
  try {
    await jfetch(srv.base, '/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: ['E1'], sessionId: 's1' }),
    });
    await new Promise((r) => setTimeout(r, 120));
    const { body } = await jfetch(srv.base, '/api/seats');
    const e1 = body.seats.find((s) => s.id === 'E1');
    assert.equal(e1.status, 'available');
  } finally {
    await srv.close();
  }
});
