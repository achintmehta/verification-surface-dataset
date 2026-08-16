# Message Board — visual/manual rubric

Scores: `pass` (full weight) | `partial` (half) | `fail` (0) | `skip` (excluded — grader-side problems ONLY; a non-booting app scores `fail` on every item).

**Grade condition-blind:** do NOT open manifest.json or the trace before scoring. Boot the app, follow the items, fill `visual-scores.json` (emitted by `grader.py --emit-scorecards`) in the run's logs directory, then re-run the grader to merge.

**Setup:** npm install; npm run dev (or start backend+frontend separately). Open the app in TWO browser windows side by side.

| id | wt | criterion |
|---|---|---|
| MB-V1 | 1 | Messages render as a readable list; history loads on first paint without user action. |
| MB-V2 | 1 | Posting: input clears on submit and the message appears immediately, with no full page reload. |
| MB-V3 | 2 | Realtime: a message posted in window A appears in window B within ~1s without reloading B. |

Notes: record anything ambiguous in the `notes` field of the scorecard rather than bending a pass/fail.