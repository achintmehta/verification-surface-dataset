// Hand-checkable fixtures for the layout engine. Not wired to a test runner
// (the project ships without one), but kept as executable documentation of the
// expected geometry. Run with: `node src/layout.test-fixtures.js` from frontend.

import { layoutDay } from './layout.js';

function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) < eps;
}

let failures = 0;
function expect(name, cond) {
  if (!cond) {
    failures++;
    console.error('FAIL:', name);
  } else {
    console.log('ok  :', name);
  }
}

const M = (h, m = 0) => h * 60 + m;

// 1. N identical events => N equal columns filling the width.
{
  const evs = [
    { id: 'a', startMin: M(9), endMin: M(10) },
    { id: 'b', startMin: M(9), endMin: M(10) },
    { id: 'c', startMin: M(9), endMin: M(10) },
  ];
  const out = layoutDay(evs);
  expect('3 identical -> width 1/3', out.every((p) => approx(p.width, 1 / 3)));
  const lefts = out.map((p) => p.left).sort((x, y) => x - y);
  expect('3 identical -> lefts 0,1/3,2/3', approx(lefts[0], 0) && approx(lefts[1], 1 / 3) && approx(lefts[2], 2 / 3));
}

// 2. Non-overlapping events => full width each.
{
  const evs = [
    { id: 'a', startMin: M(9), endMin: M(10) },
    { id: 'b', startMin: M(10), endMin: M(11) },
  ];
  const out = layoutDay(evs);
  expect('sequential -> full width', out.every((p) => approx(p.width, 1) && approx(p.left, 0)));
}

// 3. A lone event after an earlier cluster still gets full width.
{
  const evs = [
    { id: 'a', startMin: M(9), endMin: M(10) },
    { id: 'b', startMin: M(9), endMin: M(10) },
    { id: 'lone', startMin: M(14), endMin: M(15) },
  ];
  const out = layoutDay(evs);
  const lone = out.find((p) => p.id === 'lone');
  expect('lone after cluster -> full width', approx(lone.width, 1) && approx(lone.left, 0));
}

// 4. Partially overlapping chain: 9-11, 10-12, 11:30-13.
{
  const evs = [
    { id: 'x', startMin: M(9), endMin: M(11) },
    { id: 'y', startMin: M(10), endMin: M(12) },
    { id: 'z', startMin: M(11, 30), endMin: M(13) },
  ];
  const out = layoutDay(evs);
  // All transitively overlap (x-y overlap, y-z overlap) => one cluster of 2 cols.
  expect('chain -> 2 columns', out.every((p) => p.columns === 2));
  const z = out.find((p) => p.id === 'z');
  // z does not overlap x, so it can reuse column 0.
  expect('chain -> z reuses column 0', z.column === 0);
}

// 5. No two placements ever overlap visually.
{
  const evs = [
    { id: 'a', startMin: M(9), endMin: M(12) },
    { id: 'b', startMin: M(9, 30), endMin: M(10, 30) },
    { id: 'c', startMin: M(11), endMin: M(13) },
    { id: 'd', startMin: M(13), endMin: M(14) },
  ];
  const out = layoutDay(evs);
  let clean = true;
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const p = out[i];
      const q = out[j];
      const timeOverlap = p.startMin < q.endMin && q.startMin < p.endMin;
      const horizOverlap = p.left < q.left + q.width - 1e-9 && q.left < p.left + p.width - 1e-9;
      if (timeOverlap && horizOverlap) clean = false;
    }
  }
  expect('no visual overlap for any pair', clean);
}

if (failures > 0) {
  console.error(`\n${failures} fixture(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nAll layout fixtures passed.');
}
