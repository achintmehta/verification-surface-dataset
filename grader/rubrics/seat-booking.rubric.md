# Seat Booking — visual/manual rubric

Scores: `pass` (full weight) | `partial` (half) | `fail` (0) | `skip` (excluded — grader-side problems ONLY; a non-booting app scores `fail` on every item).

**Grade condition-blind:** do NOT open manifest.json or the trace before scoring. Boot the app, follow the items, fill `visual-scores.json` (emitted by `grader.py --emit-scorecards`) in the run's logs directory, then re-run the grader to merge.

**Setup:** npm install; npm run dev. Open TWO browser windows.

| id | wt | criterion |
|---|---|---|
| SB-V1 | 2 | Seat map renders the seeded grid with three visually distinct states (available / held / booked), distinguishable at a glance. |
| SB-V2 | 2 | Holding seats shows a countdown that visibly reflects the hold's remaining TTL. |
| SB-V3 | 2 | Realtime: holds/confirms/releases made in window A change seat colors in window B without reload. |
| SB-V4 | 2 | Conflict UX: when a hold fails (409), the UI indicates WHICH seats were taken and refreshes the map. |
| SB-V5 | 2 | Expiry: after the TTL elapses, held seats visibly return to available in both windows without any manual action. |

Notes: record anything ambiguous in the `notes` field of the scorecard rather than bending a pass/fail.