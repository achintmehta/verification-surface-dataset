/**
 * Test TTL expiry by directly manipulating the PGLite database to set
 * hold_expires_at in the past, then verifying the expiry sweep releases them.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, 'data/pglite');
const BASE = 'http://localhost:3001/api';

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('=== TTL Expiry Test ===\n');

  // 1. Create a hold via the API
  const { data: holdData, status: s1 } = await req('POST', '/holds', {
    seatIds: ['A4', 'A5'],
    sessionId: 'ttl-test-session',
  });
  console.log(`1. Created hold: HTTP ${s1}, ID=${holdData.hold?.id}`);
  const holdId = holdData.hold?.id;
  if (!holdId) throw new Error('No hold ID');

  // 2. Verify seats are held
  const { data: seats1 } = await req('GET', '/seats');
  const a4 = seats1.find(s => s.id === 'A4');
  console.log(`2. A4 status: ${a4.status} ✓`);
  if (a4.status !== 'held') throw new Error('A4 should be held');

  // 3. Directly expire the hold in the DB (we open a second PGLite connection
  //    to the same data dir - this is safe since the server is not running
  //    a query right now, and we just need to set the timestamp)
  console.log('\n3. Directly expiring hold in DB...');
  const db = new PGlite(DATA_DIR);
  await db.waitReady;

  await db.query(
    `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE hold_id = $1`,
    [holdId]
  );
  await db.query(
    `UPDATE holds SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
    [holdId]
  );
  await db.close();
  console.log('   Done. Hold is now expired in DB.');

  // 4. Wait for the expiry worker to run (it runs every 5s)
  //    OR just call GET /api/seats which triggers lazy expiry
  console.log('\n4. Calling GET /api/seats to trigger lazy expiry...');
  const { data: seats2 } = await req('GET', '/seats');
  const a4b = seats2.find(s => s.id === 'A4');
  const a5b = seats2.find(s => s.id === 'A5');
  console.log(`   A4 status: ${a4b.status}, A5 status: ${a5b.status}`);
  if (a4b.status !== 'available') throw new Error(`A4 should be available after expiry, got ${a4b.status}`);
  if (a5b.status !== 'available') throw new Error(`A5 should be available after expiry, got ${a5b.status}`);
  console.log('   ✅ Seats released by lazy expiry on read');

  // 5. Try to confirm the expired hold
  const { data: confirmExpired, status: s5 } = await req('POST', `/holds/${holdId}/confirm`, {
    sessionId: 'ttl-test-session',
  });
  console.log(`\n5. Confirm expired hold: HTTP ${s5} - ${confirmExpired.error}`);
  if (s5 !== 409) throw new Error(`Expected 409, got ${s5}`);
  console.log('   ✅ Expired hold correctly rejected');

  // 6. Verify the released seats can be held by someone else
  const { data: newHold, status: s6 } = await req('POST', '/holds', {
    seatIds: ['A4'],
    sessionId: 'new-session-after-expiry',
  });
  console.log(`\n6. New hold on A4 after expiry: HTTP ${s6}`);
  if (s6 !== 201) throw new Error(`Expected 201, got ${s6}`);
  console.log('   ✅ Seat A4 can be held again after expiry');

  // 7. Final inventory check
  const { data: allSeats } = await req('GET', '/seats');
  const available = allSeats.filter(s => s.status === 'available').length;
  const held = allSeats.filter(s => s.status === 'held').length;
  const booked = allSeats.filter(s => s.status === 'booked').length;
  console.log(`\n7. Final inventory: available=${available}, held=${held}, booked=${booked}, total=${available+held+booked}`);
  if (available + held + booked !== 50) throw new Error('Inventory mismatch!');
  console.log('   ✅ Inventory correct');

  console.log('\n✅ All TTL expiry tests passed!');
}

main().catch(err => {
  console.error('❌ TTL expiry test failed:', err.message);
  process.exit(1);
});
