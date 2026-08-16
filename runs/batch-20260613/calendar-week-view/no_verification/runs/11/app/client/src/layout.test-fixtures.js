// Hand-verifiable fixtures for the layout engine. These are not wired to a
// test runner (the project ships no runner), but document the expected
// geometry that the acceptance criteria pin down. Each fixture can be checked
// by eye against layoutDay()'s output.
//
// To exercise manually in a Node REPL or browser console:
//   import { layoutDay, verticalPlacement } from './layout.js';

import { layoutDay, verticalPlacement, MINUTES_PER_DAY } from './layout.js';

const DAY = new Date(2024, 0, 1, 0, 0, 0, 0); // local midnight

function at(h, m = 0) {
  return new Date(2024, 0, 1, h, m, 0, 0);
}

function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

const results = [];
function check(name, cond) {
  results.push({ name, pass: !!cond });
}

// --- Vertical geometry: 09:00–10:30 spans exactly 1.5 hours -----------------
{
  const { topFrac, heightFrac } = verticalPlacement(
    { start: at(9), end: at(10, 30) },
    DAY
  );
  check('09:00 top = 9/24', approx(topFrac, 9 / 24));
  check('1.5h height = 1.5/24', approx(heightFrac, 1.5 / 24));
}

// --- Event ending at 24:00 terminates exactly at the bottom edge ------------
{
  const { topFrac, heightFrac } = verticalPlacement(
    { start: at(23), end: new Date(2024, 0, 2, 0, 0, 0, 0) },
    DAY
  );
  check('23:00 top = 23/24', approx(topFrac, 23 / 24));
  check('ends at bottom edge (top+height = 1)', approx(topFrac + heightFrac, 1));
}

// --- N identical events -> N equal-width side-by-side blocks ----------------
{
  const evts = [
    { id: 1, title: 'A', start: at(9), end: at(10) },
    { id: 2, title: 'B', start: at(9), end: at(10) },
    { id: 3, title: 'C', start: at(9), end: at(10) },
  ];
  const placed = layoutDay(evts, DAY);
  const widths = placed.map((p) => p.widthFrac);
  check('3 identical -> all width 1/3', widths.every((w) => approx(w, 1 / 3)));
  const lefts = placed.map((p) => p.leftFrac).sort((a, b) => a - b);
  check(
    '3 identical -> lefts 0, 1/3, 2/3 fill the column',
    approx(lefts[0], 0) && approx(lefts[1], 1 / 3) && approx(lefts[2], 2 / 3)
  );
}

// --- Partially overlapping chain: all visible, contended width only ---------
{
  const evts = [
    { id: 1, title: 'X', start: at(9), end: at(11) },
    { id: 2, title: 'Y', start: at(10), end: at(12) },
    { id: 3, title: 'Z', start: at(11, 30), end: at(13) },
  ];
  const placed = layoutDay(evts, DAY);
  check('chain renders all 3', placed.length === 3);
  // All three are in one transitive cluster (9-11 overlaps 10-12; 10-12
  // overlaps 11:30-13). Greedy columns: X->col0, Y->col1, Z reuses col0
  // (X ended at 11 <= 11:30). columnCount = 2 -> width 1/2 each.
  check('chain cluster width = 1/2', placed.every((p) => approx(p.widthFrac, 1 / 2)));
}

// --- Non-overlapping event takes full width even with earlier cluster -------
{
  const evts = [
    { id: 1, title: 'A', start: at(9), end: at(10) },
    { id: 2, title: 'B', start: at(9), end: at(10) }, // cluster of 2 earlier
    { id: 3, title: 'C', start: at(14), end: at(15) }, // alone later
  ];
  const placed = layoutDay(evts, DAY);
  const c = placed.find((p) => p.event.id === 3);
  check('later lone event full width', approx(c.widthFrac, 1) && approx(c.leftFrac, 0));
}

// --- No two blocks overlap (horizontal x vertical) for the chain ------------
{
  const evts = [
    { id: 1, title: 'X', start: at(9), end: at(11) },
    { id: 2, title: 'Y', start: at(10), end: at(12) },
    { id: 3, title: 'Z', start: at(11, 30), end: at(13) },
  ];
  const placed = layoutDay(evts, DAY);
  let anyOverlap = false;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      const hOverlap =
        a.leftFrac < b.leftFrac + b.widthFrac - 1e-9 &&
        b.leftFrac < a.leftFrac + a.widthFrac - 1e-9;
      const vOverlap =
        a.topFrac < b.topFrac + b.heightFrac - 1e-9 &&
        b.topFrac < a.topFrac + a.heightFrac - 1e-9;
      if (hOverlap && vOverlap) anyOverlap = true;
    }
  }
  check('no two blocks overlap', !anyOverlap);
}

export function runFixtures() {
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  }
  return results.every((r) => r.pass);
}

export { results, MINUTES_PER_DAY };
