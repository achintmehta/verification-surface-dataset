# Calendar Week View — visual/manual rubric

Scores: `pass` (full weight) | `partial` (half) | `fail` (0) | `skip` (excluded — grader-side problems ONLY; a non-booting app scores `fail` on every item).

**Grade condition-blind:** do NOT open manifest.json or the trace before scoring. Boot the app, follow the items, fill `visual-scores.json` (emitted by `grader.py --emit-scorecards`) in the run's logs directory, then re-run the grader to merge.

**Setup:** npm install; npm run dev. Create events through the UI as instructed per item.

| id | wt | criterion |
|---|---|---|
| CW-V1 | 3 | Create 3 events with the IDENTICAL time range (e.g. Tue 09:00-10:00): they render as 3 equal-width blocks side by side, together filling the day column; none hidden. |
| CW-V2 | 3 | Create a partial-overlap chain (09:00-11:00, 10:00-12:00, 11:30-13:00): every event fully visible; width is divided only while contended. |
| CW-V3 | 2 | Vertical geometry: a 09:00-10:30 event's top edge aligns with the 09:00 gridline and bottom edge halfway between 10:00 and 11:00. |
| CW-V4 | 2 | A non-overlapping event later the same day uses the FULL column width even though a cluster exists earlier that day. |
| CW-V5 | 1 | An event ending at 24:00 terminates exactly at the column's bottom edge; nothing renders outside its day column. |
| CW-V6 | 1 | Long titles truncate with ellipsis inside their block; no text spills outside. |
| CW-V7 | 1 | Click/drag on empty space opens a create form pre-filled with the selected range; editing and deleting update the rendered week immediately. |
| CW-V8 | 1 | Prev/Today/Next navigation re-renders correctly; today's column is visually indicated on the correct day. |

Notes: record anything ambiguous in the `notes` field of the scorecard rather than bending a pass/fail.