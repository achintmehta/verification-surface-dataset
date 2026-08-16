/**
 * Full expiry test:
 * 1. Start server, create a hold
 * 2. Stop server, manually expire the hold in DB
 * 3. Restart server - the first GET /api/seats should trigger lazy expiry
 * 4. Verify seats are available
 * 5. Verify confirming the expired hold fails
 */

import { PGlite } from '@electric-sql/pglite';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, 'data/pglite');

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function req(method, urlPath, body) {
  const res = await fetch(`http://localhost:3001/api${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function waitForServer(maxMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch('http://localhost:3001/api/health');
      if (res.ok) return true;
    } catch {}
    await sleep(200);
  }
  throw new Error('Server did not start in time');
}

async function startServer() {
  const proc = spawn('node', ['server/src/index.js'], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  proc.stderr.on('data', d => process.stderr.write(`[server-err] ${d}`));
  await waitForServer();
  return proc;
}

async function stopServer(proc) {
  proc.kill('SIGTERM');
  await sleep(500);
}

async function main() {
  console.log('=== Full Expiry Integration Test ===\n');

  // Phase 1: Start server and create a hold
  console.log('Phase 1: Starting server and creating hold...');
  let server = await startServer();

  const { data: holdData, status: s1 } = await req('POST', '/holds', {
    seatIds: ['A6', 'A7'],
    sessionId: 'full-expiry-session',
  });
  if (s1 !== 201) throw new Error(`Expected 201, got ${s1}: ${JSON.stringify(holdData)}`);
  const holdId = holdData.hold.id;
  console.log(`Created hold ${holdId} for A6, A7`);

  // Verify held
  const { data: seats1 } = await req('GET', '/seats');
  const a6 = seats1.find(s => s.id === 'A6');
  if (a6.status !== 'held') throw new Error('A6 should be held');
  console.log('A6 is held ✓');

  // Phase 2: Stop server, expire the hold in DB
  console.log('\nPhase 2: Stopping server and expiring hold in DB...');
  await stopServer(server);

  const db = new PGlite(DATA_DIR);
  await db.waitReady;
  await db.query(
    `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '5 seconds' WHERE hold_id = $1`,
    [holdId]
  );
  await db.query(
    `UPDATE holds SET expires_at = NOW() - INTERVAL '5 seconds' WHERE id = $1`,
    [holdId]
  );
  const { rows: check } = await db.query(
    `SELECT id, hold_expires_at FROM seats WHERE hold_id = $1`,
    [holdId]
  );
  console.log(`Expired hold in DB. Seats: ${check.map(s => `${s.id}@${s.hold_expires_at}`).join(', ')}`);
  await db.close();

  // Phase 3: Restart server
  console.log('\nPhase 3: Restarting server...');
  server = await startServer();
  console.log('Server restarted ✓');

  // Phase 4: GET /api/seats should trigger lazy expiry
  console.log('\nPhase 4: Fetching seats (triggers lazy expiry)...');
  const { data: seats2 } = await req('GET', '/seats');
  const a6b = seats2.find(s => s.id === 'A6');
  const a7b = seats2.find(s => s.id === 'A7');
  console.log(`A6 status: ${a6b.status}, A7 status: ${a7b.status}`);
  if (a6b.status !== 'available') throw new Error(`A6 should be available, got ${a6b.status}`);
  if (a7b.status !== 'available') throw new Error(`A7 should be available, got ${a7b.status}`);
  console.log('✅ Seats released by lazy expiry on read');

  // Phase 5: Confirm expired hold should fail
  console.log('\nPhase 5: Confirming expired hold...');
  const { data: confirmData, status: s5 } = await req('POST', `/holds/${holdId}/confirm`, {
    sessionId: 'full-expiry-session',
  });
  console.log(`Confirm expired hold: HTTP ${s5} - ${confirmData.error}`);
  if (s5 !== 409) throw new Error(`Expected 409, got ${s5}`);
  console.log('✅ Expired hold correctly rejected');

  // Phase 6: Seats can be held by someone else
  console.log('\nPhase 6: New hold on A6 after expiry...');
  const { data: newHold, status: s6 } = await req('POST', '/holds', {
    seatIds: ['A6'],
    sessionId: 'new-session-post-expiry',
  });
  if (s6 !== 201) throw new Error(`Expected 201, got ${s6}: ${JSON.stringify(newHold)}`);
  console.log('✅ A6 can be held again after expiry');

  // Phase 7: Inventory check
  const { data: allSeats } = await req('GET', '/seats');
  const available = allSeats.filter(s => s.status === 'available').length;
  const held = allSeats.filter(s => s.status === 'held').length;
  const booked = allSeats.filter(s => s.status === 'booked').length;
  console.log(`\nFinal inventory: available=${available}, held=${held}, booked=${booked}, total=${available+held+booked}`);
  if (available + held + booked !== 50) throw new Error('Inventory mismatch!');
  console.log('✅ Inventory correct');

  await stopServer(server);
  console.log('\n✅ All full expiry tests passed!');
}

main().catch(err => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});
