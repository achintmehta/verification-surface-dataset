# Visual Rubrics — human grading workflow

These rubrics are the study's universal grading instrument: every application has one,
and every run is hand-graded against it (rendering, drag-and-drop feel, responsiveness,
realtime UX). The automated probes are secondary checks for the subset of targeted
behaviors that are also observable over the API. One rubric per
spec: `<spec>.rubric.md` is the human-readable card, `<spec>.rubric.json` is the same
content consumed by automatic_probes.py (blank-card emission) and merge_results.py
(scoring). Edit the JSON and regenerate/keep the .md in sync.

## Workflow

1. **Emit scorecards** (once per batch):
   `python3 automatic_probes.py <runs>/* --emit-scorecards ...`
   writes a blank `visual-scores.json` next to each run's manifest (never overwrites).
2. **Grade condition-blind.** Boot the app per the card's Setup line, follow the items,
   fill each item's `score` with `pass` | `partial` | `fail` | `skip`, add `notes`
   where judgment was involved, and set `grader_name`.
   - Do NOT open manifest.json or trace.jsonl before scoring: knowing the condition is
     exactly the bias this protocol exists to prevent. Grade runs in shuffled order.
   - A non-booting app scores `fail` on every item (criteria unmet), never `skip`.
     `skip` is reserved for grader-side problems (your environment, not the artifact)
     and is excluded from the denominator. `fail` = assessable and wrong.
3. **Verify, then merge:** run `verify_pre_merge_results.py` (flags blank/partial/
   invalid cards), then `merge_results.py` — the ONLY place cards become scores.
   Filled scorecards become `human_pct_current` in run-summary.csv (weighted:
   pass=1, partial=0.5, fail=0), with the per-item map in `visual_items.jsonl`.
   Then `verify_post_merge_results.py` re-checks the join independently. In the
   paper, ALWAYS report functional_pct (machine) and the human score separately;
   never let them blend.

## Reliability requirements for publication

- Grade a random ~20% of runs twice (second grader or yourself after a washout) and
  report inter-rater agreement (e.g. Cohen's kappa on item level).
- The rubric weights are part of the instrument: freeze them before grading a batch;
  changing them mid-study is the same class of error as changing a tool definition.
- Specs `calendar-week-view`, `metrics-dashboard`, and `log-explorer-perf` currently
  grade as boot + rubric only (functional_pct = null; kanban-labels-brownfield reuses
  the kanban probes for its regression half); API probe modules for them are future
  work in automatic_probes.py.

## Automating later

Most items in calendar-week-view and metrics-dashboard are mechanically checkable with
a headless browser (bounding-box overlap, scrollWidth vs viewport, DOM-node counts).
A Playwright-based probe layer can replace those human items one-for-one when run on a
host where `playwright install chromium` is permitted; keep item IDs stable so human
and automated scores remain comparable across batches.
