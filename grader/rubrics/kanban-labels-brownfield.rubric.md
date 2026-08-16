# Kanban Labels (Brownfield) — visual/manual rubric

Scores: `pass` (full weight) | `partial` (half) | `fail` (0) | `skip` (excluded — grader-side problems ONLY; a non-booting app scores `fail` on every item).

**Grade condition-blind:** do NOT open manifest.json or the trace before scoring. Boot the app, follow the items, fill `visual-scores.json` (emitted by `grader.py --emit-scorecards`) in the run's logs directory, then re-run the grader to merge.

**Setup:** npm install; npm run dev. Open TWO browser windows. Includes regression checks on the original board.

| id | wt | criterion |
|---|---|---|
| BL-V1 | 2 | Cards display their labels as colored chips matching each label's color. |
| BL-V2 | 2 | Label manager UI: create (name + color), rename, recolor, and delete all work from the UI with validation feedback on duplicates/empty names. |
| BL-V3 | 2 | Filtering: multi-selecting labels hides exactly the non-matching cards; clearing restores all; the other window's view is NOT affected. |
| BL-V4 | 2 | Realtime: assigning/removing a label in window A updates the chips in window B without reload; deleting a label removes its chips everywhere. |
| BL-V5 | 2 | REGRESSION: original drag-and-drop still works smoothly with labels rendered (pickup, drop position, no flicker). |

Notes: record anything ambiguous in the `notes` field of the scorecard rather than bending a pass/fail.