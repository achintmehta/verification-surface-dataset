// Concurrency & correctness test for the seat service. Runs in-process against
// a fresh temporary PGLite database (no HTTP needed). Exercises the acceptance
// criteria directly against seatService.
import { rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Configure a temp DB dir, short TTL, BEFORE importing modules that read config.
const tmp = mkdtempSync(join(tmpdir(), 'seat-test-'));
process.env.DB_DIR = tmp;
process.env.HOLD_TTL_MS = '700';
process.env.SEAT_ROWS = '5';
process.env.SEAT_COLS = '10';

const { initDb } = await import('../server/db.js');
const svc = await import('../server/seatService.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function inventoryBalances(label) {
  const inv = await svc.getInventory();
  assert(
    inv.available + inv.held + inv.booked === inv.total,
    `${label}: inventory balances (${inv.available}+${inv.held}+${inv.booked}=${inv.total})`
  );
  return inv;
}

async function main() {
  await initDb();
  // Quiet the broadcaster.
  svc.setBroadcaster(() => {});

  console.log('Test 1: Concurrent holds on the same seat — exactly one wins');
  {
    const seats = await svc.getSeats();
    const target = seats[0].id;
    const N = 40;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        svc.createHold([target], `sess-${i}`)
      )
    );
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    assert(winners.length === 1, `exactly one hold succeeded (got ${winners.length})`);
    assert(
      losers.every((r) => r.code === 409 && r.conflicts.includes(target)),
      'all losers got 409 with conflicting seat id'
    );
    await inventoryBalances('after concurrent single-seat holds');
    // cleanup
    await svc.releaseHold(winners[0].hold.id, winners[0].hold.sessionId);
  }

  console.log('Test 2: All-or-nothing multi-seat hold');
  {
    const seats = await svc.getSeats();
    const a = seats[10].id, b = seats[11].id, c = seats[12].id;
    // Pre-hold b by someone else.
    const pre = await svc.createHold([b], 'other');
    assert(pre.ok, 'pre-hold of middle seat succeeded');
    // Now try to hold a,b,c — must fail and acquire none.
    const r = await svc.createHold([a, b, c], 'me');
    assert(!r.ok && r.code === 409, 'multi-seat hold rejected with 409');
    assert(r.conflicts.includes(b), 'conflict lists the taken seat');
    const after = await svc.getSeats();
    assert(after.find((s) => s.id === a).status === 'available', 'seat a stayed available (nothing acquired)');
    assert(after.find((s) => s.id === c).status === 'available', 'seat c stayed available (nothing acquired)');
    await svc.releaseHold(pre.hold.id, 'other');
  }

  console.log('Test 3: Hold blocks others until released/confirmed/expired');
  {
    const seats = await svc.getSeats();
    const id = seats[20].id;
    const h = await svc.createHold([id], 'holder');
    assert(h.ok, 'holder placed a hold');
    const blocked = await svc.createHold([id], 'intruder');
    assert(!blocked.ok && blocked.code === 409, 'other user blocked while held');
    await svc.releaseHold(h.hold.id, 'holder');
    const free = await svc.createHold([id], 'intruder');
    assert(free.ok, 'after release, seat is acquirable again');
    await svc.releaseHold(free.hold.id, 'intruder');
  }

  console.log('Test 4: Auto-expiry frees seats without manual action');
  {
    const seats = await svc.getSeats();
    const id = seats[30].id;
    const h = await svc.createHold([id], 'forgetful');
    assert(h.ok, 'hold placed');
    await sleep(900); // > TTL (700ms)
    const after = await svc.getSeats(); // read triggers lazy expiry
    assert(after.find((s) => s.id === id).status === 'available', 'expired hold freed the seat on read');
    await inventoryBalances('after expiry');
  }

  console.log('Test 5: Confirming an expired hold fails and books nothing');
  {
    const seats = await svc.getSeats();
    const id = seats[31].id;
    const h = await svc.createHold([id], 'late');
    assert(h.ok, 'hold placed');
    await sleep(900);
    const conf = await svc.confirmHold(h.hold.id, 'late');
    assert(!conf.ok && conf.code === 410, 'expired confirm rejected (410)');
    const after = await svc.getSeats();
    assert(after.find((s) => s.id === id).status !== 'booked', 'nothing was booked');
  }

  console.log('Test 6: Idempotent confirmation books exactly once');
  {
    const seats = await svc.getSeats();
    const ids = [seats[40].id, seats[41].id];
    const h = await svc.createHold(ids, 'buyer');
    assert(h.ok, 'hold placed');
    const c1 = await svc.confirmHold(h.hold.id, 'buyer');
    const c2 = await svc.confirmHold(h.hold.id, 'buyer');
    const c3 = await svc.confirmHold(h.hold.id, 'buyer');
    assert(c1.ok && c2.ok && c3.ok, 'all three confirms returned ok');
    assert(c2.alreadyConfirmed && c3.alreadyConfirmed, 'repeat confirms flagged alreadyConfirmed');
    const same =
      JSON.stringify(c1.booking.seatIds.sort()) ===
      JSON.stringify(c2.booking.seatIds.sort()) &&
      JSON.stringify(c2.booking.seatIds.sort()) ===
      JSON.stringify(c3.booking.seatIds.sort());
    assert(same, 'all confirms returned the same booking');
    const after = await svc.getSeats();
    const bookedCount = after.filter((s) => ids.includes(s.id) && s.status === 'booked').length;
    assert(bookedCount === ids.length, 'seats booked exactly once');
  }

  console.log('Test 7: Cannot hold a booked seat; booked seat never double-sold');
  {
    const seats = await svc.getSeats();
    const id = seats[40].id; // booked in test 6
    const r = await svc.createHold([id], 'someone-else');
    assert(!r.ok && r.code === 409, 'cannot hold a booked seat');
  }

  console.log('Test 8: Heavy concurrent mixed holds keep inventory exact');
  {
    const seats = await svc.getSeats();
    const pool = seats.filter((s) => s.status === 'available').slice(0, 20).map((s) => s.id);
    const ops = [];
    for (let i = 0; i < 100; i++) {
      const pick = [pool[i % pool.length], pool[(i * 7 + 3) % pool.length]];
      ops.push(svc.createHold([...new Set(pick)], `bulk-${i}`));
    }
    const results = await Promise.all(ops);
    // Confirm half the winners.
    const winners = results.filter((r) => r.ok);
    await Promise.all(
      winners.map((w, i) =>
        i % 2 === 0
          ? svc.confirmHold(w.hold.id, w.hold.sessionId)
          : svc.releaseHold(w.hold.id, w.hold.sessionId)
      )
    );
    const inv = await inventoryBalances('after heavy mixed load');
    // No seat may be booked by two sessions — verify uniqueness of booked_by per seat is inherent (single column).
    const all = await svc.getSeats();
    const booked = all.filter((s) => s.status === 'booked');
    assert(booked.every((s) => !!s.bookedBy), 'every booked seat has exactly one owner');
    assert(inv.total === 50, 'total seat count unchanged');
  }

  console.log('Test 9: Confirming unknown hold fails');
  {
    const r = await svc.confirmHold('does-not-exist', 'nobody');
    assert(!r.ok && r.code === 404, 'unknown hold confirm rejected (404)');
  }

  console.log('');
  if (failures === 0) {
    console.log('ALL TESTS PASSED ✅');
  } else {
    console.error(`${failures} ASSERTION(S) FAILED ❌`);
  }

  await rm(tmp, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Test harness error:', err);
  await rm(tmp, { recursive: true, force: true });
  process.exit(1);
});
