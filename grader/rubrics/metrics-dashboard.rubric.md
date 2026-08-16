# Metrics Dashboard — visual/manual rubric

Scores: `pass` (full weight) | `partial` (half) | `fail` (0) | `skip` (excluded — grader-side problems ONLY; a non-booting app scores `fail` on every item).

**Grade condition-blind:** do NOT open manifest.json or the trace before scoring. Boot the app, follow the items, fill `visual-scores.json` (emitted by `grader.py --emit-scorecards`) in the run's logs directory, then re-run the grader to merge.

**Setup:** npm install; npm run dev. Use browser DevTools responsive mode for the width items.

| id | wt | criterion |
|---|---|---|
| MD-V1 | 3 | At 360px width: single-column layout, NO horizontal page scroll, no clipped or overlapping element anywhere on the page. |
| MD-V2 | 2 | At 768px: two-column structure as specified, no overflow. |
| MD-V3 | 2 | At 1280px: four stat cards in one row; chart and category breakdown side by side below. |
| MD-V4 | 2 | Chart fits its container at all three widths (axis labels and full series visible, nothing drawn outside) and redraws correctly after resizing the window. |
| MD-V5 | 1 | The long seeded category label truncates with ellipsis; the 7-digit value fits its stat card. |
| MD-V6 | 2 | Dark mode restyles the ENTIRE dashboard including chart axes/gridlines/series; all text remains legible (no dark-on-dark). |
| MD-V7 | 1 | Theme choice survives a page reload (and a server restart). |

Notes: record anything ambiguous in the `notes` field of the scorecard rather than bending a pass/fail.