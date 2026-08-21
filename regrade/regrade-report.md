# Re-grade report: intra-rater agreement on the 10% sample
Protocol: `REGRADE_RUNBOOK.md` (repo root), written 3 Aug 2026, before the
sample was drawn. This report implements its step 5 and its reporting rules.

## Process

All 1,116 runs were graded once by a single grader, condition-blind, between
2026-07-02 and 2026-07-15. Four weeks after grading closed, a 10 percent
sample (112 runs; seed 20260812) was drawn stratified proportionally across
task × condition, excluding the 18 runs re-opened during manuscript writing
(`exclusions.csv`) and keeping never-launched runs in the frame. Two sampled
runs whose `node_modules` trees were no longer on disk were replaced from
their own cells (seed 20260816; `SWAPS.csv`). The sample was staged under
opaque identifiers R001–R112 with blanked cards and graded in a fresh
shuffled order over four sessions, 2026-08-16 to 2026-08-19
(`SESSIONS.txt`), against the same rubric and accommodation rules as the
first pass, with the original cards, grading notes, and specimen notebook
out of view. Blinding was procedural, not mechanically enforced: the sealed
mapping could have been opened at any time; it was not opened until all 112
cards were scored.

## The numbers

Computed by `analyse.py` from the second-pass cards as finalized against the 
first-pass record in `freeze-20260720/visual_items.jsonl`. The split follows 
the runbook, because non-launched runs are all-fail by rule and agreement on 
them is close to automatic:

| split | per-item exact agreement | linearly weighted kappa | ICC(A,1) on human_pct | mean abs diff | survival agreement |
|---|---|---|---|---|---|
| launched (105 runs, 552 item comparisons) | 545/552 = 98.7% | 0.940 | 0.991 | 0.56 pts | 105/105 |
| non-launched (7 runs, 44 comparisons) | 44/44 = 100% | n/a (no variance) | n/a | 0.00 | 7/7 |
| pooled (112 runs, 596 comparisons) | 589/596 = 98.8% | 0.973 | 0.997 | 0.52 pts | 112/112 |

Using the Landis–Koch bands these are "almost perfect". The bands are named
descriptively, and per the runbook no pass threshold was declared. Two item
comparisons were excluded as skips (R081, SB-V4/SB-V5, one skip in each
pass). 92.6 percent of first-pass item verdicts on launched runs are "pass,"
so raw agreement overstates and kappa/ICC are the informative figures.

The survival numbers were same on all 112 runs, and zero runs moved between 
a zero and a non-zero score, so the accommodation rule is stable under 
re-measurement.  This includes the one sampled RENDERS-BROKEN survivor
(log-explorer-perf/execution/29: renders, shows no data, 0 percent both
passes, survivor both passes).

However, seven of 112 runs moved with the largest movement was 15 points:

| rid | run | first | second | Δ |
|---|---|---|---|---|
| R090 | kanban-board/no_verification/27 | 100.0 | 85.0 | 15.0 |
| R020 | log-explorer-perf/no_verification/22 | 100.0 | 90.0 | 10.0 |
| R021 | seat-booking/execution/4 | 100.0 | 90.0 | 10.0 |
| R036 | kanban-labels-brownfield/visual/26 | 80.0 | 90.0 | 10.0 |
| R047 | kanban-board/delayed_verification/6 | 100.0 | 95.0 | 5.0 |
| R077 | kanban-board/visual/7 | 100.0 | 95.0 | 5.0 |
| R024 | calendar-week-view/execution/19 | 96.4 | 100.0 | 3.6 |

The seven item-level disagreements: 
R020 LE-V2 Original pass -    Regrade partial
R021 SB-V3 Original pass -    Regrade partial
R024 CW-V7 Original partial - Regrade pass
R036 BL-V2 Original fail -    Regrade partial
R047 KB-V4 Original pass -    Regrade partial
R077 KB-V4 Original pass -    Regrade partial
R090 KB-V1Original  pass -    Regrade partial.
Every disagreement is between adjacent categories and none went from 
pass to fail.

## Environment notes

- Grading ran against the June `node_modules` trees and lockfiles. They were
  never reinstalled (1,101 trees, 1,116 lockfiles present at check on
  2026-08-15). Two sampled runs lacking trees were replaced, not rebuilt.

