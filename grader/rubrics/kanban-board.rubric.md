# Kanban Board — visual/manual rubric

Scores: `pass` (full weight) | `partial` (half) | `fail` (0) | `skip` (excluded — grader-side problems ONLY; a non-booting app scores `fail` on every item).

**Grade condition-blind:** do NOT open manifest.json or the trace before scoring. Boot the app, follow the items, fill `visual-scores.json` (emitted by `grader.py --emit-scorecards`) in the run's logs directory, then re-run the grader to merge.

**Setup:** npm install; npm run dev. Open TWO browser windows. Create a few cards first.

| id | wt | criterion |
|---|---|---|
| KB-V1 | 3 | Drag-and-drop works with the mouse: card can be picked up, dragged across columns, and dropped at a chosen position (not only appended). |
| KB-V2 | 3 | Optimistic UI: the dragged card lands instantly on drop (no visible wait for the server), and does not flicker or snap back when the move succeeds. |
| KB-V3 | 2 | Convergence: after moves in both windows (including moving the SAME card in both), both windows settle to the identical order; no duplicate or lost card. |
| KB-V4 | 1 | Robustness: dropping a card outside any valid target leaves the board intact (card returns; nothing disappears). |
| KB-V5 | 1 | Layout: columns side by side, card text readable, no overlapping or clipped elements at a normal desktop width. |

Notes: record anything ambiguous in the `notes` field of the scorecard rather than bending a pass/fail.