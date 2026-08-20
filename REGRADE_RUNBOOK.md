# Re-grade runbook for the 10% intra-rater check

Written 3 Aug 2026, before the sample was drawn. Any change made after the draw
gets a dated note underneath rather than an edit in place.

## What this measures

All 1,116 runs were graded by one person, and it might be worth exploring
that whether the same reviewer gives the app the same score twice, 
weeks apart, with the original notes out of view?

This says nothing about whether the scoring was right but focuses on repeatibility.

## Timeline: not before 12 Aug 2026

The original grading closed at 15 Jul 2026. We add four weeks of washout to that.

Work since 15 Jul has been analysis code, figures and manuscript
prose, not the apps themselves. Aggregate numbers do not refresh artifact
memory: knowing that boot_check averages 91.7 gives no help in scoring
calendar/static/23. The only artifact-level re-reading was the specimen runs,
which are excluded below.

For the re-grading process log the grading days in `regrade/SESSIONS.txt`
as they happen and not later from memory.

## Do NOT reinstall dependencies

The June `node_modules` trees and lockfiles are still on disk. Grading will be
done against them.

The reason for this is a fresh `npm install` in August may resolve different 
versions than June did.  The app would then behaves differently, and any 
disagreement observed could either be grader inconsistency or environment drift, 
with no easy way to separate them. That would make this exercise moot.

Check which npm modules are still available first, and record the numbers in `regrade/ENVIRONMENT.txt`:

```bash
ls -d runs/batch-20260613/*/*/runs/*/app/node_modules 2>/dev/null | wc -l
ls runs/batch-20260613/*/*/runs/*/app/package-lock.json 2>/dev/null | wc -l
node --version; npm --version
```

If a sampled run has lost its `node_modules`, do not rebuild it. Do not consider it
run for regrading and draw a replacement from the same task/condition cell, and log the swap.

## 1. Exclusions

Anything reopened since 15 Jul has been excluded, even though they were opened for trivial reasons
e.g verifying claims made during the manuscript preparation or fixing typos.

Exclusions have to be documented in `regrade/exclusions.csv` — task, condition, run_id, reason

## 2. Draw the sample

112 runs (10% of 1,116), stratified proportionally across task x condition so
no arm goes unrepresented. Fixed seed, script committed next to its output.

Runs that never launched should stay in the frame. Their cards are all-fail by the pre-defined 
rules. Launch failures would get reported separately (step 5) rather than averaged in silently.

Document the samples to run in `regrade/_sealed/sample.csv`, `regrade/draw_sample.py`

```bash
python3 regrade/draw_sample.py --seed 20260812 --n 112 \
        --exclude regrade/exclusions.csv --out regrade/_sealed/sample.csv
```

## 3. Stage it blind

The existing paths are `task/condition/runs/id`, so grading from these paths reveals the
condition on sight.  In order to avoid seeing the conditions stage under opaque IDs e.g.
`regrade/R001` through `R112` each with a blank card, plus a mapping file that stays closed.

Create for each run `regrade/R0xx/card.json` (blank), `regrade/_sealed/MAPPING.csv`
(sealed), `regrade/order.txt`

```bash
python3 automatic_probes.py --emit-scorecards <run_dir>
# then shuffle into order.txt with a second recorded seed
```

This is blinding by discipline, not by mechanism. `MAPPING.csv` can be 
opened at any moment. It stays closed until all 112 cards are scored, 
and the write-up says that the safeguard was procedural rather than
enforced by tooling.

## 4. Re-grade process

Re-grading process follows the same rules for the main run which are doucmented in 
`guidelines/app-grading-guide.md`. We will use the same launch
accommodations, pass/partial/fail per item, and any notes where they help.

Re-read the grading guide before starting. The point is to apply the written
criteria again, not to reproduce a memory of the first pass. When a call feels
uncertain, settle it from the criteria.

Grade each process in the rubric card under the `regrade` directory.
## 5. Analyse

After the regrading of 112 runs is complete, analyze the results and document them in
`regrade/agreement.csv`, `regrade/regrade-report.md`

Split the analysis with following four numbers, each split three ways — launched runs, non-launched runs, pooled:

- per-item exact agreement
- linearly weighted kappa (the items are ordinal; unweighted understates)
- ICC on `human_pct`, plus mean absolute difference in points
- binary agreement on the survival call, which carries the headline result

The result can be described with the usual Landis–Koch labels i.e. fair, moderate, substantial, almost perfect. 
No minimum score is set in advance which the re-grade has to clear. Setting a bar and then missing it turns an 
ordinary number into a failure that needs explaining away. We will simply report whatever the number turns out to be.
