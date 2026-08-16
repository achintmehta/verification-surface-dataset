import { describe, it, expect } from 'vitest';
import {
  verticalPlacement,
  layoutDay,
  layoutEventsForDay,
  MINUTES_PER_DAY,
} from './layout.js';

const DAY = new Date(2024, 4, 6, 0, 0, 0, 0); // Mon May 6 2024, local
const dayStart = DAY;
const dayEnd = new Date(2024, 4, 7, 0, 0, 0, 0);

function at(h, m = 0) {
  return new Date(2024, 4, 6, h, m, 0, 0);
}

describe('verticalPlacement', () => {
  it('maps 09:00-10:30 to exact minutes', () => {
    const v = verticalPlacement(at(9), at(10, 30), dayStart, dayEnd);
    expect(v.topMin).toBe(540);
    expect(v.heightMin).toBe(90);
  });

  it('an event ending at 24:00 reaches the bottom edge exactly', () => {
    const v = verticalPlacement(at(22), dayEnd, dayStart, dayEnd);
    expect(v.topMin).toBe(1320);
    expect(v.topMin + v.heightMin).toBe(MINUTES_PER_DAY);
  });

  it('clamps an event extending past midnight to the day end', () => {
    const next = new Date(2024, 4, 7, 2, 0, 0, 0);
    const v = verticalPlacement(at(23), next, dayStart, dayEnd);
    expect(v.topMin).toBe(1380);
    expect(v.topMin + v.heightMin).toBe(MINUTES_PER_DAY);
  });

  it('clamps an event starting before the day to the day start', () => {
    const prev = new Date(2024, 4, 5, 23, 0, 0, 0);
    const v = verticalPlacement(prev, at(1), dayStart, dayEnd);
    expect(v.topMin).toBe(0);
    expect(v.heightMin).toBe(60);
  });

  it('returns null when there is no intersection', () => {
    const prevDayStart = new Date(2024, 4, 5, 0);
    const prevDayEnd = new Date(2024, 4, 5, 1);
    expect(verticalPlacement(prevDayStart, prevDayEnd, dayStart, dayEnd)).toBeNull();
  });
});

function mk(id, startMin, endMin) {
  return { id, topMin: startMin, heightMin: endMin - startMin };
}

function noOverlap(results) {
  // For any two results that overlap vertically, their horizontal ranges
  // must be disjoint.
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i];
      const b = results[j];
      const aTop = a.topMin, aBot = a.topMin + a.heightMin;
      const bTop = b.topMin, bBot = b.topMin + b.heightMin;
      const vOverlap = aTop < bBot && bTop < aBot;
      if (!vOverlap) continue;
      const aL = a.leftFrac, aR = a.leftFrac + a.widthFrac;
      const bL = b.leftFrac, bR = b.leftFrac + b.widthFrac;
      const hOverlap = aL < bR - 1e-9 && bL < aR - 1e-9;
      expect(hOverlap, `events ${a.id} and ${b.id} overlap both axes`).toBe(false);
    }
  }
}

describe('layoutDay', () => {
  it('single event fills full width', () => {
    const r = layoutDay([mk('a', 540, 600)]);
    expect(r).toHaveLength(1);
    expect(r[0].widthFrac).toBeCloseTo(1);
    expect(r[0].leftFrac).toBeCloseTo(0);
  });

  it('N identical events become N equal columns filling the width', () => {
    const items = ['a', 'b', 'c'].map((id) => mk(id, 540, 600));
    const r = layoutDay(items);
    expect(r).toHaveLength(3);
    for (const x of r) expect(x.widthFrac).toBeCloseTo(1 / 3);
    const lefts = r.map((x) => x.leftFrac).sort((p, q) => p - q);
    expect(lefts[0]).toBeCloseTo(0);
    expect(lefts[1]).toBeCloseTo(1 / 3);
    expect(lefts[2]).toBeCloseTo(2 / 3);
    // Together fill full width.
    const maxRight = Math.max(...r.map((x) => x.leftFrac + x.widthFrac));
    expect(maxRight).toBeCloseTo(1);
    noOverlap(r);
  });

  it('partially overlapping chain stays fully visible & divides only while contended', () => {
    // 09:00-11:00, 10:00-12:00, 11:30-13:00
    const items = [
      mk('a', 540, 660),
      mk('b', 600, 720),
      mk('c', 690, 780),
    ];
    const r = layoutDay(items);
    expect(r).toHaveLength(3);
    noOverlap(r);
    // All three are in one transitive cluster: a-b overlap, b-c overlap.
    // Max simultaneous overlap is 2, so 2 columns are enough.
    for (const x of r) expect(x.widthFrac).toBeCloseTo(0.5);
  });

  it('a non-overlapping later event uses full width even after an earlier cluster', () => {
    const items = [
      mk('a', 540, 600), // 9-10
      mk('b', 540, 600), // 9-10 overlapping a
      mk('c', 720, 780), // 12-13 alone
    ];
    const r = layoutDay(items);
    const c = r.find((x) => x.id === 'c');
    expect(c.widthFrac).toBeCloseTo(1);
    expect(c.leftFrac).toBeCloseTo(0);
    const a = r.find((x) => x.id === 'a');
    const b = r.find((x) => x.id === 'b');
    expect(a.widthFrac).toBeCloseTo(0.5);
    expect(b.widthFrac).toBeCloseTo(0.5);
    noOverlap(r);
  });

  it('touching events (end == next start) are NOT considered overlapping', () => {
    const items = [mk('a', 540, 600), mk('b', 600, 660)];
    const r = layoutDay(items);
    for (const x of r) expect(x.widthFrac).toBeCloseTo(1);
    noOverlap(r);
  });

  it('handles a dense random-ish set without any overlap', () => {
    const items = [
      mk('a', 0, 1440),
      mk('b', 100, 200),
      mk('c', 150, 250),
      mk('d', 150, 160),
      mk('e', 800, 900),
      mk('f', 850, 1000),
      mk('g', 1430, 1440),
    ];
    const r = layoutDay(items);
    noOverlap(r);
    // every event present
    expect(new Set(r.map((x) => x.id)).size).toBe(items.length);
    // widths and lefts within bounds
    for (const x of r) {
      expect(x.leftFrac).toBeGreaterThanOrEqual(-1e-9);
      expect(x.leftFrac + x.widthFrac).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe('layoutEventsForDay', () => {
  it('lays out raw events and clamps to the day', () => {
    const events = [
      { id: 1, title: 'A', start_at: at(9).toISOString(), end_at: at(10).toISOString() },
      { id: 2, title: 'B', start_at: at(9).toISOString(), end_at: at(10).toISOString() },
    ];
    const r = layoutEventsForDay(events, dayStart, dayEnd);
    expect(r).toHaveLength(2);
    for (const x of r) {
      expect(x.widthFrac).toBeCloseTo(0.5);
      expect(x.event).toBeTruthy();
    }
  });
});
