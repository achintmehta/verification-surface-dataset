/**
 * Lightweight assertions for the layout engine. Not wired to a test runner
 * (none is provisioned); run manually with `node web/src/layout.test.js`.
 * Serves as executable documentation of the acceptance geometry.
 */
import { layoutDayEvents } from './layout.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error('FAIL:', msg);
  } else {
    console.log('ok  :', msg);
  }
}
const approx = (a, b) => Math.abs(a - b) < 1e-9;

// 1. Exact vertical geometry: 09:00–10:30 -> top 540/1440, height 90/1440.
{
  const [e] = layoutDayEvents([{ id: 1, start: 540, end: 630 }]);
  assert(approx(e.top, 540 / 1440), 'single event top exact');
  assert(approx(e.height, 90 / 1440), 'single event height exact (1.5h)');
  assert(approx(e.left, 0) && approx(e.width, 1), 'single event full width');
}

// 2. N identical events -> N equal columns filling width.
{
  const laid = layoutDayEvents([
    { id: 1, start: 540, end: 600 },
    { id: 2, start: 540, end: 600 },
    { id: 3, start: 540, end: 600 },
  ]);
  assert(laid.every((e) => approx(e.width, 1 / 3)), '3 identical -> width 1/3');
  const lefts = laid.map((e) => e.left).sort((a, b) => a - b);
  assert(
    approx(lefts[0], 0) && approx(lefts[1], 1 / 3) && approx(lefts[2], 2 / 3),
    '3 identical -> lefts 0,1/3,2/3'
  );
}

// 3. Partially overlapping chain: 9-11, 10-12, 11:30-13.
{
  const laid = layoutDayEvents([
    { id: 1, start: 540, end: 660 }, // 9-11
    { id: 2, start: 600, end: 720 }, // 10-12
    { id: 3, start: 690, end: 780 }, // 11:30-13
  ]);
  // All three transitively overlap -> one cluster. Max concurrency is 2
  // (event 3 reuses event 1's column). So width should be 1/2.
  assert(laid.every((e) => approx(e.width, 1 / 2)), 'chain -> width 1/2');
  const e3 = laid.find((e) => e.id === 3);
  const e1 = laid.find((e) => e.id === 1);
  assert(approx(e1.left, 0) && approx(e3.left, 0), 'event 3 reuses column 0');
}

// 4. Isolated event later same day takes full width.
{
  const laid = layoutDayEvents([
    { id: 1, start: 540, end: 600 },
    { id: 2, start: 540, end: 600 },
    { id: 3, start: 800, end: 860 }, // disjoint cluster
  ]);
  const e3 = laid.find((e) => e.id === 3);
  assert(approx(e3.width, 1) && approx(e3.left, 0), 'later isolated -> full width');
}

// 5. Clamp to 24:00.
{
  const [e] = layoutDayEvents([{ id: 1, start: 1380, end: 1500 }]);
  assert(approx(e.top + e.height, 1), 'event ending past midnight clamps to bottom');
}

// 6. No two events overlap visually within a cluster.
{
  const laid = layoutDayEvents([
    { id: 1, start: 0, end: 120 },
    { id: 2, start: 30, end: 150 },
    { id: 3, start: 60, end: 200 },
  ]);
  for (let i = 0; i < laid.length; i++) {
    for (let j = i + 1; j < laid.length; j++) {
      const a = laid[i];
      const b = laid[j];
      const vOverlap = a.top < b.top + b.height && b.top < a.top + a.height;
      const hOverlap = a.left < b.left + b.width - 1e-9 && b.left < a.left + a.width - 1e-9;
      assert(!(vOverlap && hOverlap), `events ${a.id},${b.id} do not visually overlap`);
    }
  }
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURE(S)`);
if (failures > 0 && typeof process !== 'undefined') process.exitCode = 1;
