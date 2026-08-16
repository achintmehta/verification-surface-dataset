# Log Explorer (Performance) — visual/manual rubric

Scores: `pass` (full weight) | `partial` (half) | `fail` (0) | `skip` (excluded — grader-side problems ONLY; a non-booting app scores `fail` on every item).

**Grade condition-blind:** do NOT open manifest.json or the trace before scoring. Boot the app, follow the items, fill `visual-scores.json` (emitted by `grader.py --emit-scorecards`) in the run's logs directory, then re-run the grader to merge.

**Setup:** npm install; npm run dev; wait for first-boot seeding. Use DevTools (Elements panel) for the DOM item.

| id | wt | criterion |
|---|---|---|
| LE-V1 | 3 | Scrolling through the 100k-row list is smooth: no page freeze, no permanently blank viewport regions, at top/middle/bottom. |
| LE-V2 | 2 | The scrollbar reflects the filtered total; dragging it to the middle or end shows plausible, correctly-ordered rows for that position. |
| LE-V3 | 2 | Typing in the search box stays responsive while results update; rapid query changes never leave stale results on screen. |
| LE-V4 | 1 | Severity color-coding is visible and the 'N of <total>' indicator updates with each filter change. |
| LE-V5 | 2 | DevTools check: the number of rendered row elements stays bounded (~100 or fewer) regardless of scroll position. |

Notes: record anything ambiguous in the `notes` field of the scorecard rather than bending a pass/fail.