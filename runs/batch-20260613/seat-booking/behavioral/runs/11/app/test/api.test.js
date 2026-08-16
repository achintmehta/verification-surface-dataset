import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { ROWS, SEATS_PER_ROW } from '../server/config.js';

const TOTAL = ROWS.length * SEATS_PER_ROW;

async function startServer() {
  const db = await createDb('memory://');
  const { app } = createApp(db, { sweepIntervalMs: 0 });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return { server, base };
}

test('GET /api/seats returns seats and inventory', async () => {
  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/api/seats`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.seats.length, TOTAL);
    assert.equal(body.inventory.total, TOTAL);
    assert.equal(body.inventory.available, TOTAL);
  } finally {
    server.close();
  }
}); 

test('full hold -> confirm flow over HTTP', async () => {
  const { server, base } = await startServer();
  try {
    const holdRes = await fetch(`${base}/api/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: ['A1', 'A2'], sessionId: 's1' }),
    });
    assert.equal(holdRes.status, 201);
    const hold = await holdRes.json();
    assert.deepEqual(hold.seatIds.sort(), ['A1', 'A2']);

    const confirmRes = await fetch(`${base}/api/holds/${hold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    });
    assert.equal(confirmRes.status, 200);
    const confirmBody = await confirmRes.json();
    assert.deepEqual(confirmBody.booking.seatIds.sort(), ['A1', 'A2']);

    // Idempotent repeat
    const again = await fetch(`${base}/api/holds/${hold.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    });
    assert.equal(again.status, 200);
    const againBody = await again.json();
    assert.equal(againBody.idempotent, true);

    const inv = await (await fetch(`${base}/api/inventory`)).json();
    assert.equal(inv.booked, 2);
  } finally {
    server.close();
  }
});

test('conflicting hold returns 409 with conflicts', async () => {
  const { server, base } = await startServer();
  try {
    await fetch(`${base}/api/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: ['B1'], sessionId: 's1' }),
    });
    const res = await fetch(`${base}/api/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: ['B1', 'B2'], sessionId: 's2' }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.deepEqual(body.conflicts, ['B1']);
  } finally {
    server.close();
  }
});

test('DELETE /api/holds/:id releases the hold', async () => {
  const { server, base } = await startServer();
  try {
    const hold = await (
      await fetch(`${base}/api/holds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seatIds: ['C1'], sessionId: 's1' }),
      })
    ).json();

    const del = await fetch(`${base}/api/holds/${hold.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    });
    assert.equal(del.status, 200);

    const inv = await (await fetch(`${base}/api/inventory`)).json();
    assert.equal(inv.available, TOTAL);
  } finally {
    server.close();
  }
});

test('SSE stream delivers seat change events', async () => {
  const { server, base } = await startServer();
  try {
    const controller = new AbortController();
    const streamRes = await fetch(`${base}/api/stream`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    assert.equal(streamRes.status, 200);

    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();

    // Trigger a change after the stream is open.
    const holdPromise = fetch(`${base}/api/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: ['D1'], sessionId: 's1' }),
    });

    let buffer = '';
    let received = null;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('event: seats') && buffer.includes('"D1"')) {
        const match = buffer.match(/data: (\{.*\})/);
        if (match) {
          received = JSON.parse(match[1]);
          break;
        }
      }
    }
    await holdPromise;
    controller.abort();

    assert.ok(received, 'should receive an SSE seats event');
    assert.ok(received.changes.some((c) => c.seatId === 'D1' && c.status === 'held'));
  } finally {
    server.close();
  }
});
