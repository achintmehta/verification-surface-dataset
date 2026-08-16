import assert from 'node:assert';
import { layoutEvents } from '../client/layout.js';

function run(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log('layout engine');

run('non-overlapping event uses full width', () => {
  const out = layoutEvents([{ id: '1', start: 540, end: 600 }]);
  assert.strictEqual(out[0].columnCount, 1);
  assert.strictEqual(out[0].columnIndex, 0);
});

run('N identical events -> N equal columns', () => {
  const out = layoutEvents([
    { id: '1', start: 540, end: 600 },
    { id: '2', start: 540, end: 600 },
    { id: '3', start: 540, end: 600 },
  ]);
  for (const e of out) assert.strictEqual(e.columnCount, 3);
  const cols = out.map((e) => e.columnIndex).sort();
  assert.deepStrictEqual(cols, [0, 1, 2]);
});

run('partially overlapping chain stays fully visible', () => {
  // 09:00-11:00, 10:00-12:00, 11:30-13:00
  const out = layoutEvents([
    { id: 'a', start: 540, end: 660 },
    { id: 'b', start: 600, end: 720 },
    { id: 'c', start: 690, end: 780 },
  ]);
  const byId = Object.fromEntries(out.map((e) => [e.id, e]));
  // a & b overlap; c overlaps b but not a. Max concurrency = 2.
  assert.strictEqual(byId.a.columnCount, 2);
  assert.strictEqual(byId.b.columnCount, 2);
  assert.strictEqual(byId.c.columnCount, 2);
  // a and b must be in different columns.
  assert.notStrictEqual(byId.a.columnIndex, byId.b.columnIndex);
  // c can reuse a's column (a ended at 660 <= 690).
  assert.strictEqual(byId.c.columnIndex, byId.a.columnIndex);
});

run('later non-overlapping cluster reclaims full width', () => {
  const out = layoutEvents([
    { id: 'x1', start: 540, end: 600 },
    { id: 'x2', start: 540, end: 600 },
    { id: 'y', start: 700, end: 760 },
  ]);
  const byId = Object.fromEntries(out.map((e) => [e.id, e]));
  assert.strictEqual(byId.x1.columnCount, 2);
  assert.strictEqual(byId.x2.columnCount, 2);
  assert.strictEqual(byId.y.columnCount, 1);
  assert.strictEqual(byId.y.columnIndex, 0);
});

run('no two laid-out blocks visually overlap', () => {
  const events = [
    { id: '1', start: 540, end: 660 },
    { id: '2', start: 600, end: 720 },
    { id: '3', start: 690, end: 780 },
    { id: '4', start: 540, end: 600 },
    { id: '5', start: 800, end: 900 },
  ];
  const out = layoutEvents(events);
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i];
      const b = out[j];
      const timeOverlap = a.start < b.end && b.start < a.end;
      if (!timeOverlap) continue;
      // They must be in different horizontal slots within a shared cluster.
      const aLeft = a.columnIndex / a.columnCount;
      const aRight = (a.columnIndex + 1) / a.columnCount;
      const bLeft = b.columnIndex / b.columnCount;
      const bRight = (b.columnIndex + 1) / b.columnCount;
      const horizOverlap = aLeft < bRight && bLeft < aRight;
      assert.ok(!horizOverlap, `events ${a.id} and ${b.id} overlap visually`);
    }
  }
});

console.log('done');
