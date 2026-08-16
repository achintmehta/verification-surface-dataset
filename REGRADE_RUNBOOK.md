# Re-grade runbook — the 10% intra-rater check

Written 3 Aug 2026, before the sample was drawn. Any change made after the draw
gets a dated note underneath rather than an edit in place.

## What this measures

All 1,116 runs were graded by one person, and reviewers will ask what that is
worth. This check answers one narrow version of the question: does the same
app get the same score twice, weeks apart, with the original notes out of view?

It says nothing about whether the scoring was right. A grader who is
consistently harsh on dense layouts re-grades identically and produces a fine
kappa. So the single-grader paragraph in Limitations stands as written — this
buys stability, not correctness, and the write-up must not blur the two.

## When — not before 12 Aug 2026

Grading closed 15 Jul. Four weeks of washout.

Four weeks is on the short side of common practice, so the reasoning belongs on
the record. Work since 15 Jul has been analysis code, figures and manuscript
prose, not the apps themselves. Aggregate numbers do not refresh artifact
memory: knowing that boot_check averages 91.7 gives no help in scoring
calendar/static/23. The only artifact-level re-reading was the specimen runs,
which are excluded below.

Log grading days in `regrade/SESSIONS.txt` as they happen, not afterwards from
memory.

## Do NOT reinstall dependencies

The June `node_modules` trees and lockfiles are still on disk. Grade against
them.

A fresh `npm install` in August may resolve different versions than June did.
The app then behaves differently, and any disagreement measured is part grader
inconsistency and part environment drift, with no way to separate them. That
would waste the exercise quietly, which is the worst way to waste it.

Check first, and record the numbers in `regrade/ENVIRONMENT.txt`:

```bash
ls -d runs/batch-20260613/*/*/runs/*/app/node_modules 2>/dev/null | wc -l
ls runs/batch-20260613/*/*/runs/*/app/package-lock.json 2>/dev/null | wc -l
node --version; npm --version
```

If a sampled run has lost its `node_modules`, do not rebuild it. Drop the run,
draw a replacement from the same task/condition cell, and log the swap.

## 1. Exclusions (before the draw)

Anything reopened since 15 Jul has had no washout and cannot be in the frame:

- the S1–S8 specimens in `guidelines/defect-specimens-batch-20260613.md`
- every run quoted in the manuscript, including the clamp specimen
- the ten `LAUNCH-FAILED` rows in `frontend-launch-audit.csv` whose defect
  notes were re-read during writing

**Writes:** `regrade/exclusions.csv` — task, condition, run_id, reason

Build it by hand, commit it, and report the row count in the write-up. It does
not get regenerated after the draw.

## 2. Draw the sample

112 runs (10% of 1,116), stratified proportionally across task x condition so
no arm goes unrepresented. Fixed seed, script committed next to its output.

Runs that never launched stay in the frame. Their cards are all-fail by rule,
so agreement on them is close to automatic and would flatter a pooled figure.
They get reported separately (step 5) rather than averaged in silently.

**Writes:** `regrade/sample.csv`, `regrade/draw_sample.py`

```bash
python3 regrade/draw_sample.py --seed 20260812 --n 112 \
        --exclude regrade/exclusions.csv --out regrade/sample.csv
```

## 3. Stage it blind

Live paths are `task/condition/runs/id`, so grading from them reveals the
condition on sight. The first pass was condition-blind; if the second is not,
the two are not comparable and the number means nothing.

Stage under opaque IDs — `regrade/R001` through `R112` — each with a blank
card, plus a mapping file that stays shut.

**Writes:** `regrade/R0xx/card.json` (blank), `regrade/MAPPING.csv` (sealed),
`regrade/order.txt`

```bash
python3 automatic_probes.py --emit-scorecards <run_dir>
# then shuffle into order.txt with a second recorded seed
```

Worth stating plainly: this is blinding by discipline, not by mechanism.
`MAPPING.csv` can be opened at any moment. It stays closed until all 112 cards
are scored, and the write-up says that the safeguard was procedural rather than
enforced by tooling.

## 4. Grade

Same instrument, same rules: `guidelines/app-grading-guide.md`, the same launch
accommodations, pass/partial/fail per item, notes where they help.

Re-read the grading guide before starting. The point is to apply the written
criteria again, not to reproduce a memory of the first pass. When a call feels
uncertain, settle it from the criteria — that is the measurement working, not a
problem with it.

112 runs at five to ten minutes each is roughly two long days. Keep the sittings
few, leave the originals unopened between them, and log each date.

## 5. Analyse

**Writes:** `regrade/agreement.csv`, `regrade/regrade-report.md`

Four numbers, each split three ways — launched runs, non-launched runs, pooled:

- per-item exact agreement
- linearly weighted kappa (the items are ordinal; unweighted understates)
- ICC on `human_pct`, plus mean absolute difference in points
- binary agreement on the survival call, which carries the headline result

Landis–Koch bands may be named descriptively, but no pre-declared pass
threshold. A gate that might be missed creates a problem that plain reporting
of the number does not.

## 6. Rules fixed now, before the answer is known

1. The number gets published whatever it turns out to be.
2. The re-grade revises no published score. `freeze-20260720/` is sealed and
   remains the dataset of record.
3. A genuine grading error found during the re-grade goes into
   `regrade-report.md` as a discrepancy. It does not get corrected into the data.
4. Any departure from this protocol gets written down with its date.
