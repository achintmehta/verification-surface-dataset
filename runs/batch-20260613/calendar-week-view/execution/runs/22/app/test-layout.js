// Quick test for the layout algorithm
import { layoutEventsForDay } from './frontend/layout.js';

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function makeEvent(id, startMin, endMin) {
  return { id, title: `Event ${id}`, _startMinutes: startMin, _endMinutes: endMin };
}

// Test 1: Single event uses full width
test('Single event full width', () => {
  const events = [makeEvent(1, 540, 600)]; // 09:00-10:00
  const result = layoutEventsForDay(events);
  assert(result.length === 1);
  assert(result[0].leftPercent === 0);
  assert(result[0].widthPercent === 100);
});

// Test 2: Two overlapping events side by side
test('Two overlapping events side by side', () => {
  const events = [
    makeEvent(1, 540, 660), // 09:00-11:00
    makeEvent(2, 600, 720), // 10:00-12:00
  ];
  const result = layoutEventsForDay(events);
  assert(result.length === 2);
  // Both should be 50% wide
  assert(result[0].widthPercent === 50, `Expected 50, got ${result[0].widthPercent}`);
  assert(result[1].widthPercent === 50);
  // Different left positions
  assert(result[0].leftPercent !== result[1].leftPercent);
});

// Test 3: Three identical events
test('Three identical events equal width', () => {
  const events = [
    makeEvent(1, 540, 600),
    makeEvent(2, 540, 600),
    makeEvent(3, 540, 600),
  ];
  const result = layoutEventsForDay(events);
  assert(result.length === 3);
  const widths = result.map(r => r.widthPercent);
  const lefts = result.map(r => r.leftPercent).sort((a, b) => a - b);
  assert(widths.every(w => Math.abs(w - 100/3) < 0.01), `Widths: ${widths}`);
  // All different left positions
  assert(lefts[0] !== lefts[1] && lefts[1] !== lefts[2]);
});

// Test 4: Transitive overlap chain
test('Transitive overlap chain', () => {
  const events = [
    makeEvent(1, 540, 660),  // 09:00-11:00
    makeEvent(2, 600, 720),  // 10:00-12:00
    makeEvent(3, 690, 780),  // 11:30-13:00
  ];
  const result = layoutEventsForDay(events);
  assert(result.length === 3);
  // All in one cluster, so all 1/2 width (A overlaps B, B overlaps C => all in same cluster)
  // Actually: A overlaps B (10:00 < 11:00), B overlaps C (11:30 < 12:00)
  // So cluster end extends to 13:00. All 3 in one cluster.
  // A uses col 0, B uses col 1, C can go in col 0 (A ends at 11:00 = 660, C starts at 690 > 660)
  // So only 2 columns needed
  const widths = result.map(r => r.widthPercent);
  assert(widths.every(w => w === 50), `Expected 50% widths, got ${widths}`);
});

// Test 5: Non-overlapping event gets full width
test('Non-overlapping event after cluster gets full width', () => {
  const events = [
    makeEvent(1, 540, 660),  // 09:00-11:00
    makeEvent(2, 600, 720),  // 10:00-12:00
    makeEvent(4, 840, 900),  // 14:00-15:00 (no overlap)
  ];
  const result = layoutEventsForDay(events);
  const ev4 = result.find(r => r.event.id === 4);
  assert(ev4.widthPercent === 100, `Expected 100%, got ${ev4.widthPercent}`);
  assert(ev4.leftPercent === 0);
});

// Test 6: No events
test('Empty events', () => {
  const result = layoutEventsForDay([]);
  assert(result.length === 0);
});

// Test 7: Event at 24:00 (end of day)
test('Event ending at 24:00', () => {
  const events = [makeEvent(1, 23 * 60, 24 * 60)]; // 23:00-24:00
  const result = layoutEventsForDay(events);
  assert(result.length === 1);
  assert(result[0].widthPercent === 100);
});

console.log('\nAll layout tests passed!');
