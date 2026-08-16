// Lightweight assertion-based tests for the pure layout engine.
// Run with: node src/layout.test.js  (from the client directory)
//
// These verify the acceptance criteria about geometry and overlap.

import {
  layoutDay,
  clampToDay,
  placementsOverlap,
  MINUTES_PER_DAY,
} from './layout.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error('FAIL:', msg);
  } else {
    console.log('ok  :', msg);
  }
}
function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

// Helper: build a day's items at a fixed day start.
const DAY = new Date(2024, 0, 1, 0, 0, 0, 0); // local midnight
function ev(id, startMin, endMin) {
  return {
    id,
    title: `E${id}`,
    start_at: new Date(DAY.getTime() + startMin * 60000).toISOString(),
    end_at: new Date(DAY.getTime() + endMin * 60000).toISOString(),
  };
}
function items(...events) {
  return events.map((e) => {
    const c = clampToDay(e, DAY);
    return { event: e, topMin: c.topMin, bottomMin: c.bottomMin };
  });
}

// --- Test 1: single event uses full width --------------------------------
{
  const p = layoutDay(items(ev(1, 540, 630))); // 09:00-10:30
  assert(p.length === 1, 'single event produces one placement');
  assert(approx(p[0].widthFrac, 1), 'single event full width');
  assert(approx(p[0].leftFrac, 0), 'single event at left 0');
  assert(approx(p[0].topMin, 540), 'top is 540 min');
  assert(approx(p[0].bottomMin, 630), 'bottom is 630 min');
}

// --- Test 2: N identical events -> N equal columns -----------------------
{
  const p = layoutDay(items(ev(1, 540, 600), ev(2, 540, 600), ev(3, 540, 600)));
  assert(p.length === 3, 'three identical events -> three placements');
  for (const pl of p) {
    assert(approx(pl.widthFrac, 1 / 3), 'each width is 1/3');
  }
  const lefts = p.map((pl) => pl.leftFrac).sort((a, b) => a - b);
  assert(
    approx(lefts[0], 0) && approx(lefts[1], 1 / 3) && approx(lefts[2], 2 / 3),
    'lefts are 0, 1/3, 2/3'
  );
  // together fill the width
  const right = Math.max(...p.map((pl) => pl.leftFrac + pl.widthFrac));
  assert(approx(right, 1), 'columns fill full width');
}

// --- Test 3: partially overlapping chain ---------------------------------
// 09:00-11:00, 10:00-12:00, 11:30-13:00
{
  const a = ev(1, 540, 660);
  const b = ev(2, 600, 720);
  const c = ev(3, 690, 780);
  const p = layoutDay(items(a, b, c));
  assert(p.length === 3, 'chain has three placements');
  // All three are in one transitive cluster (a-b overlap, b-c overlap),
  // needing 2 columns max (a&b overlap; c can reuse a's column since a ended).
  for (const pl of p) {
    assert(approx(pl.widthFrac, 1 / 2), `chain event ${pl.event.id} width 1/2`);
  }
  // No two placements visually overlap.
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) {
      assert(!placementsOverlap(p[i], p[j]), `chain ${i}/${j} no overlap`);
    }
  }
}

// --- Test 4: separate clusters in same day; lone event full width --------
{
  // Cluster A: two overlapping 09-10. Lone event 12-13 (no overlap).
  const p = layoutDay(
    items(ev(1, 540, 600), ev(2, 540, 600), ev(3, 720, 780))
  );
  const lone = p.find((pl) => pl.event.id === 3);
  assert(approx(lone.widthFrac, 1), 'lone later event full width');
  assert(approx(lone.leftFrac, 0), 'lone later event at left 0');
  const cluster = p.filter((pl) => pl.event.id !== 3);
  for (const pl of cluster) {
    assert(approx(pl.widthFrac, 1 / 2), 'early cluster halves width');
  }
}

// --- Test 5: adjacency is not overlap ------------------------------------
{
  // 09:00-10:00 then 10:00-11:00 share a boundary but do not overlap.
  const p = layoutDay(items(ev(1, 540, 600), ev(2, 600, 660)));
  for (const pl of p) {
    assert(approx(pl.widthFrac, 1), `adjacent event ${pl.event.id} full width`);
  }
}

// --- Test 6: clamp to day, event ending at 24:00 -------------------------
{
  const e = ev(1, 1380, MINUTES_PER_DAY); // 23:00 - 24:00
  const c = clampToDay(e, DAY);
  assert(approx(c.bottomMin, MINUTES_PER_DAY), 'event ends exactly at 24:00');
}

// --- Test 7: event crossing midnight clamps to both days -----------------
{
  // 23:00 day1 -> 01:00 day2
  const e = {
    id: 1,
    title: 'x',
    start_at: new Date(DAY.getTime() + 1380 * 60000).toISOString(),
    end_at: new Date(DAY.getTime() + (MINUTES_PER_DAY + 60) * 60000).toISOString(),
  };
  const day1 = clampToDay(e, DAY);
  assert(approx(day1.topMin, 1380) && approx(day1.bottomMin, MINUTES_PER_DAY),
    'crossing-midnight clamps to day1 bottom');
  const nextDay = new Date(DAY.getTime() + MINUTES_PER_DAY * 60000);
  const day2 = clampToDay(e, nextDay);
  assert(approx(day2.topMin, 0) && approx(day2.bottomMin, 60),
    'crossing-midnight clamps to day2 top');
}

// --- Test 8: exhaustive no-overlap on random data ------------------------
{
  let allClear = true;
  for (let trial = 0; trial < 200 && allClear; trial++) {
    const list = [];
    const n = 1 + Math.floor(Math.random() * 8);
    for (let i = 0; i < n; i++) {
      const s = Math.floor(Math.random() * (MINUTES_PER_DAY - 1));
      const len = 1 + Math.floor(Math.random() * (MINUTES_PER_DAY - s));
      list.push(ev(i + 1, s, Math.min(MINUTES_PER_DAY, s + len)));
    }
    const p = layoutDay(items(...list));
    for (let i = 0; i < p.length && allClear; i++) {
      for (let j = i + 1; j < p.length; j++) {
        if (placementsOverlap(p[i], p[j])) {
          allClear = false;
          console.error('overlap in trial', trial, p[i], p[j]);
          break;
        }
      }
    }
  }
  assert(allClear, 'no visual overlap across 200 random trials');
}

if (failures === 0) {
  console.log('\nAll layout tests passed.');
} else {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
}
