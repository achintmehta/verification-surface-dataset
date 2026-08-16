#!/usr/bin/env python3
"""
draw_sample.py - draw the 10% intra-rater re-grade sample.

Stratified proportionally across task x condition (largest-remainder allocation,
so the cell counts sum to exactly --n). Deterministic given --seed.

Output goes to regrade/_sealed/ because it names conditions. Do not open
anything under _sealed/ until grading is finished - see REGRADE_RUNBOOK.md.

    python3 regrade/draw_sample.py --seed 20260812 --n 112 \
            --exclude regrade/exclusions.csv --out regrade/_sealed/sample.csv
"""
import argparse, csv, random, sys
from collections import defaultdict
from pathlib import Path

DEFAULT_SUMMARY = "freeze-20260720/run-summary.csv"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, required=True)
    ap.add_argument("--n", type=int, default=112)
    ap.add_argument("--exclude", default="regrade/exclusions.csv")
    ap.add_argument("--summary", default=DEFAULT_SUMMARY)
    ap.add_argument("--out", default="regrade/_sealed/sample.csv")
    a = ap.parse_args()

    rows = list(csv.DictReader(open(a.summary, encoding="utf-8")))
    if not rows:
        sys.exit(f"no rows in {a.summary}")

    excl = set()
    ep = Path(a.exclude)
    if ep.exists():
        for r in csv.DictReader(ep.open(encoding="utf-8")):
            excl.add((r["task"].strip(), r["condition"].strip(), r["run_id"].strip()))
    else:
        sys.exit(f"missing {a.exclude} - build the exclusion list before drawing "
                 "(REGRADE_RUNBOOK.md step 1)")

    frame = [r for r in rows
             if (r["task"], r["condition"], r["run_id"]) not in excl]
    dropped = len(rows) - len(frame)

    cells = defaultdict(list)
    for r in frame:
        cells[(r["task"], r["condition"])].append(r)
    for k in cells:
        cells[k].sort(key=lambda r: int(r["run_id"]))          # stable ordering

    # largest-remainder allocation so the parts sum to exactly n
    total = len(frame)
    keys = sorted(cells)
    exact = {k: a.n * len(cells[k]) / total for k in keys}
    alloc = {k: int(exact[k]) for k in keys}
    short = a.n - sum(alloc.values())
    for k in sorted(keys, key=lambda k: (-(exact[k] - alloc[k]), k))[:short]:
        alloc[k] += 1
    for k in keys:                                             # never over-draw a cell
        alloc[k] = min(alloc[k], len(cells[k]))

    rng = random.Random(a.seed)
    picked = []
    for k in keys:
        picked += rng.sample(cells[k], alloc[k])

    # top up deterministically if capping left us short
    if len(picked) < a.n:
        pool = [r for k in keys for r in cells[k] if r not in picked]
        pool.sort(key=lambda r: (r["task"], r["condition"], int(r["run_id"])))
        picked += rng.sample(pool, a.n - len(picked))

    picked.sort(key=lambda r: (r["task"], r["condition"], int(r["run_id"])))

    out = Path(a.out); out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["task", "condition", "run_id"])
        for r in picked:
            w.writerow([r["task"], r["condition"], r["run_id"]])

    print(f"frame {len(frame)} runs ({dropped} excluded)  ->  drew {len(picked)}")
    print(f"seed {a.seed}, {len(keys)} task x condition cells")
    print(f"wrote {out}")
    per_cond = defaultdict(int)
    for r in picked:
        per_cond[r["condition"]] += 1
    for c in sorted(per_cond):
        print(f"   {c:22s} {per_cond[c]}")


if __name__ == "__main__":
    main()
