// Concurrency & correctness test suite for the seat-booking service.
// Runs against booking.js directly (in-process) using a temporary PGLite dir.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Use a fresh temp data dir and a short TTL for expiry tests.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));
process.env.PGLITE_DIR = tmpDir;
// Long enough that serialized holds don't expire mid-test; the dedicated
// expiry test below overrides the per-hold TTL explicitly.
process.env.HOLD_TTL_MS = '30000';

const { createHold, confirmHold, releaseHold, getSeats, getInventory } = await import(
  '../server/booking.js'
);
const { TOTAL_SEATS } = await import('../server/db.js');

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ✓ ${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function assertBalanced(msg) {
  const inv = await getInventory();
  assert.strictEqual(
    inv.available + inv.held + inv.booked,
    TOTAL_SEATS,
    `inventory must balance (${msg}): ${JSON.stringify(inv)}`
  );
  assert.ok(inv.balances, `balances flag (${msg})`);
}

async function main() {
  console.log('Concurrency & correctness tests\n');

  // --- 1. Concurrent holds for the SAME seat: exactly one wins. ---
  {
    const seatId = 'A1';
    const N = 40;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => createHold([seatId], `sess-${i}`))
    );
    const successes = results.filter((r) => r.status === 'fulfilled');
    const conflicts = results.filter(
      (r) => r.status === 'rejected' && r.reason.status === 409
    );
    assert.strictEqual(successes.length, 1, 'exactly one hold should succeed');
    assert.strictEqual(conflicts.length, N - 1, 'all others must 409');
    ok('concurrent holds for same seat: exactly one succeeds');
    await assertBalanced('after race');

    // Confirm the winner books exactly that seat for one session.
    const winner = successes[0].value;
    const booking = await confirmHold(winner.holdId, winner.sessionId);
    assert.deepStrictEqual(booking.seatIds, [seatId]);
    ok('winner confirms and books the seat');
  }

  // --- 2. No seat booked by two sessions (multi-seat contention). ---
  {
    const pool = ['B1', 'B2', 'B3', 'B4', 'B5'];
    const N = 30;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        createHold(pool, `multi-${i}`).then((h) => confirmHold(h.holdId, h.sessionId))
      )
    );
    const booked = results.filter((r) => r.status === 'fulfilled');
    assert.strictEqual(booked.length, 1, 'only one session can book the full block');
    const seats = await getSeats();
    const bookedByMap = {};
    for (const s of seats.filter((x) => pool.includes(x.id) && x.status === 'booked')) {
      bookedByMap[s.bookedBy] = (bookedByMap[s.bookedBy] || 0) + 1;
    }
    assert.strictEqual(Object.keys(bookedByMap).length, 1, 'block booked by single session');
    ok('no seat booked by two different sessions (all-or-nothing block)');
    await assertBalanced('after block contention');
  }

  // --- 3. Active hold blocks others. ---
  {
    const h = await createHold(['C1'], 'holder');
    await assert.rejects(
      () => createHold(['C1'], 'intruder'),
      (e) => e.status === 409 && e.conflicts.includes('C1'),
      'held seat blocks others'
    );
    ok('active hold blocks other holders');
    await releaseHold(h.holdId, 'holder');
    // Now available again.
    const h2 = await createHold(['C1'], 'intruder');
    assert.ok(h2.holdId);
    ok('released hold frees seat for others');
    await releaseHold(h2.holdId, 'intruder');
  }

  // --- 4. Auto-expiry frees seats without manual action. ---
  {
    const h = await createHold(['D1', 'D2'], 'expirer', 800); // short TTL
    let seats = await getSeats();
    assert.strictEqual(seats.find((s) => s.id === 'D1').status, 'held');
    await sleep(1000); // > TTL (800ms)
    seats = await getSeats(); // read enforces expiry
    assert.strictEqual(seats.find((s) => s.id === 'D1').status, 'available');
    assert.strictEqual(seats.find((s) => s.id === 'D2').status, 'available');
    ok('hold auto-expires after TTL, seats become available');
    await assertBalanced('after expiry');

    // --- 5. Confirming an expired hold fails and books nothing. ---
    await assert.rejects(
      () => confirmHold(h.holdId, 'expirer'),
      (e) => e.status === 410,
      'expired hold cannot be confirmed'
    );
    seats = await getSeats();
    assert.strictEqual(seats.find((s) => s.id === 'D1').status, 'available');
    ok('confirming expired hold fails and books nothing');
  }

  // --- 6. Confirming an unknown hold fails. ---
  {
    await assert.rejects(
      () => confirmHold('00000000-0000-0000-0000-000000000000', 'x'),
      (e) => e.status === 404,
      'unknown hold rejected'
    );
    ok('confirming unknown hold fails');
  }

  // --- 7. Idempotent confirmation: repeated confirms book once. ---
  {
    const h = await createHold(['E1', 'E2'], 'idem');
    const first = await confirmHold(h.holdId, 'idem');
    const second = await confirmHold(h.holdId, 'idem');
    const third = await confirmHold(h.holdId, 'idem');
    assert.deepStrictEqual(first.seatIds.sort(), ['E1', 'E2']);
    assert.deepStrictEqual(second.seatIds.sort(), ['E1', 'E2']);
    assert.ok(second.idempotent, 'second confirm flagged idempotent');
    assert.ok(third.idempotent, 'third confirm flagged idempotent');
    ok('confirmation is idempotent (books exactly once)');
    await assertBalanced('after idempotent confirms');
  }

  // --- 8. Concurrent confirms of the same hold book once. ---
  {
    const h = await createHold(['E5', 'E6'], 'cc');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => confirmHold(h.holdId, 'cc'))
    );
    for (const r of results) {
      assert.deepStrictEqual(r.seatIds.sort(), ['E5', 'E6']);
    }
    const seats = await getSeats();
    const bookedBy = new Set(
      seats.filter((s) => ['E5', 'E6'].includes(s.id)).map((s) => s.bookedBy)
    );
    assert.strictEqual(bookedBy.size, 1, 'booked by exactly one session');
    ok('concurrent confirms of same hold book exactly once');
  }

  // --- 9. Cannot release a confirmed (booked) hold. ---
  {
    const h = await createHold(['B1' === 'B1' ? 'C5' : 'C5'], 'rel');
    await confirmHold(h.holdId, 'rel');
    await assert.rejects(
      () => releaseHold(h.holdId, 'rel'),
      (e) => e.status === 409,
      'cannot release booked seats'
    );
    ok('cannot release an already-confirmed hold');
  }

  // --- 10. Final inventory balance check. ---
  await assertBalanced('final');
  ok('inventory always balances');

  console.log(`\nAll ${passed} checks passed ✅`);
}

main()
  .then(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ TEST FAILED:', err);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
