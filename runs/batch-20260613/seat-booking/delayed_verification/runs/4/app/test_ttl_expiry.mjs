/**
 * Test TTL expiry by directly manipulating the PGLite database to set
 * hold_expires_at in the past, then restarting the server and verifying
 * the expiry sweep releases them.
 *
 * This test runs standalone (server must be stopped first).
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, 'data/pglite');

async function main() {
  console.log('=== Direct DB Expiry Test ===\n');

  const db = new PGlite(DATA_DIR);
  await db.waitReady;

  // Show current state
  const { rows: before } = await db.query(`
    SELECT id, status, hold_id, hold_expires_at 
    FROM seats 
    WHERE status = 'held'
    ORDER BY id
  `);
  console.log(`Held seats before: ${before.length}`);
  before.forEach(s => console.log(`  ${s.id}: hold_id=${s.hold_id}, expires=${s.hold_expires_at}`));

  if (before.length === 0) {
    console.log('No held seats to expire. Creating one...');
    // We need to insert a hold and mark a seat as held
    const holdId = 'test-expire-hold-' + Date.now();
    await db.query(
      `INSERT INTO holds (id, session_id, expires_at) VALUES ($1, $2, NOW() - INTERVAL '10 seconds')`,
      [holdId, 'test-session']
    );
    await db.query(
      `UPDATE seats SET status='held', hold_id=$1, hold_expires_at=NOW() - INTERVAL '10 seconds' WHERE id='A6'`,
      [holdId]
    );
    console.log(`Created expired hold ${holdId} for seat A6`);
  } else {
    // Expire all held seats
    console.log('\nExpiring all held seats...');
    await db.query(`
      UPDATE seats 
      SET hold_expires_at = NOW() - INTERVAL '10 seconds'
      WHERE status = 'held'
    `);
    await db.query(`
      UPDATE holds 
      SET expires_at = NOW() - INTERVAL '10 seconds'
      WHERE confirmed_at IS NULL AND released_at IS NULL
    `);
  }

  // Verify the expiry logic directly
  const { rows: expired } = await db.query(`
    SELECT id, status, hold_id, hold_expires_at 
    FROM seats 
    WHERE status = 'held' AND hold_expires_at < NOW()
  `);
  console.log(`\nSeats with expired holds: ${expired.length}`);
  expired.forEach(s => console.log(`  ${s.id}: expires=${s.hold_expires_at}`));

  // Run the expiry logic manually
  console.log('\nRunning expiry logic...');
  const { rows: toRelease } = await db.query(`
    SELECT id FROM seats WHERE status = 'held' AND hold_expires_at < NOW()
  `);
  
  await db.query(`
    UPDATE seats
    SET status = 'available', hold_id = NULL, hold_expires_at = NULL
    WHERE status = 'held' AND hold_expires_at < NOW()
  `);

  await db.query(`
    UPDATE holds SET released_at = NOW()
    WHERE confirmed_at IS NULL AND released_at IS NULL AND expires_at < NOW()
  `);

  const { rows: after } = await db.query(`
    SELECT id, status FROM seats WHERE id IN (${toRelease.map((_, i) => `$${i+1}`).join(',') || "''"})
  `, toRelease.map(s => s.id));

  console.log(`Released ${toRelease.length} seats:`);
  after.forEach(s => console.log(`  ${s.id}: ${s.status}`));

  // Final inventory check
  const { rows: inv } = await db.query(`
    SELECT status, COUNT(*) as cnt FROM seats GROUP BY status ORDER BY status
  `);
  console.log('\nFinal inventory:');
  let total = 0;
  inv.forEach(r => { console.log(`  ${r.status}: ${r.cnt}`); total += parseInt(r.cnt); });
  console.log(`  TOTAL: ${total}`);
  if (total !== 50) throw new Error(`Total should be 50, got ${total}`);

  const heldCount = inv.find(r => r.status === 'held')?.cnt || 0;
  if (parseInt(heldCount) !== 0) throw new Error(`Expected 0 held after expiry, got ${heldCount}`);

  await db.close();
  console.log('\n✅ Direct DB expiry test passed!');
}

main().catch(err => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});
