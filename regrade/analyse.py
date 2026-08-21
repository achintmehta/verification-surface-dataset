#!/usr/bin/env python3
"""
analyse.py - intra-rater agreement between the original grading pass and the
10% re-grade. Implements REGRADE_RUNBOOK.md step 5 and nothing else.

Four measures, each split three ways (launched / non-launched / pooled):
  - per-item exact agreement
  - linearly weighted kappa (items are ordinal: fail < partial < pass)
  - ICC(A,1) on human_pct, plus mean absolute difference in points
  - binary agreement on the survival call

Definitions are taken from the shipped pipeline, not reinvented here:
  scoring        pass=1, partial=0.5, fail=0, skip/blank excluded;
                 human_pct = 100 * earned / max_of_graded   (merge_results.py)
  survival       card score > 0, or an all-fail card adjudicated
                 RENDERS-BROKEN  (the card-only re-derivation in
                 verify_post_merge_results.py)
  launched       runs_via_declared_path in the sealed run-summary

Landis-Koch bands are printed descriptively. The runbook fixes no pass
threshold on purpose.

    python3 regrade/analyse.py
"""
import csv, json, sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(".")
FREEZE = ROOT / "freeze-20260720"
VALID = {"pass": 1.0, "partial": 0.5, "fail": 0.0, "skip": None}
ORD = {"fail": 0, "partial": 1, "pass": 2}
CATS = ["fail", "partial", "pass"]


def load_weights():
    w = {}
    for f in (ROOT / "grader" / "rubrics").glob("*.rubric.json"):
        r = json.loads(f.read_text(encoding="utf-8"))
        w[f.name.replace(".rubric.json", "")] = {it["id"]: it["weight"] for it in r.get("items", [])}
    return w


def human_pct(items, weights):
    earned = mx = 0.0
    for iid, wt in weights.items():
        sc = str((items.get(iid) or "")).strip().lower()
        if sc not in VALID or VALID[sc] is None:
            continue
        earned += VALID[sc] * wt
        mx += wt
    return round(100 * earned / mx, 1) if mx else None


def survived(items, weights, key, renders_broken):
    pct = human_pct(items, weights)
    if pct is None:
        return None
    return True if pct > 0 else (key in renders_broken)


def weighted_kappa(pairs):
    """Linearly weighted kappa over ordered categories fail<partial<pass."""
    n = len(pairs)
    if not n:
        return None
    k = len(CATS)
    obs = Counter(pairs)
    r1 = Counter(a for a, _ in pairs)
    r2 = Counter(b for _, b in pairs)
    def w(i, j):
        return 1 - abs(i - j) / (k - 1)
    po = sum(w(ORD[a], ORD[b]) * c / n for (a, b), c in obs.items())
    pe = sum(w(ORD[a], ORD[b]) * (r1[a] / n) * (r2[b] / n) for a in CATS for b in CATS)
    return None if abs(1 - pe) < 1e-12 else (po - pe) / (1 - pe)


def icc_a1(x, y):
    """Two-way, absolute agreement, single measurement - ICC(A,1)."""
    n = len(x)
    if n < 2:
        return None
    k = 2
    grand = sum(x + y) / (n * k)
    rows = [(a + b) / 2 for a, b in zip(x, y)]
    cols = [sum(x) / n, sum(y) / n]
    ssr = k * sum((r - grand) ** 2 for r in rows)
    ssc = n * sum((c - grand) ** 2 for c in cols)
    sst = sum((v - grand) ** 2 for v in x + y)
    sse = sst - ssr - ssc
    msr = ssr / (n - 1)
    msc = ssc / (k - 1)
    mse = sse / ((n - 1) * (k - 1))
    den = msr + (k - 1) * mse + k * (msc - mse) / n
    return None if abs(den) < 1e-12 else (msr - mse) / den


def band(v):
    if v is None:
        return "n/a"
    for hi, name in ((0.0, "poor"), (0.20, "slight"), (0.40, "fair"),
                     (0.60, "moderate"), (0.80, "substantial"), (1.01, "almost perfect")):
        if v <= hi:
            return name
    return "almost perfect"


def main():
    weights = load_weights()

    mapping = list(csv.DictReader((ROOT / "regrade/_sealed/MAPPING.csv").open(encoding="utf-8")))
    if not mapping:
        sys.exit("no MAPPING.csv - nothing to analyse")

    first = {}
    for line in (FREEZE / "visual_items.jsonl").open(encoding="utf-8"):
        r = json.loads(line)
        first[(r["task"], r["condition"], r["run_id"])] = r.get("items") or {}

    summary = {(r["task"], r["condition"], r["run_id"]): r
               for r in csv.DictReader((FREEZE / "run-summary.csv").open(encoding="utf-8"))}

    renders_broken = set()
    fla = FREEZE / "frontend-launch-audit.csv"
    if fla.exists():
        for r in csv.DictReader(fla.open(encoding="utf-8", errors="replace")):
            seg = (r.get("app") or "").replace("\\", "/").split("/")
            if len(seg) >= 4 and any("RENDERS-BROKEN" in str(v) for v in r.values()):
                renders_broken.add((seg[0], seg[1], seg[3]))

    rows, item_pairs, skipped = [], defaultdict(list), 0
    for m in mapping:
        rid, key = m["rid"], (m["task"], m["condition"], m["run_id"])
        a = first.get(key)
        if a is None:
            sys.exit(f"{rid}: no first-pass record for {key}")
        b = {k: (v or {}).get("score") for k, v in
             json.loads((ROOT / "regrade" / rid / "card.json").read_text(encoding="utf-8"))["items"].items()}
        w = weights[m["task"]]

        agree = total = 0
        for iid in w:
            s1 = str(a.get(iid) or "").strip().lower()
            s2 = str(b.get(iid) or "").strip().lower()
            if s1 not in ORD or s2 not in ORD:
                skipped += 1
                continue
            total += 1
            agree += (s1 == s2)
            item_pairs[key].append((s1, s2))

        p1, p2 = human_pct(a, w), human_pct(b, w)
        launched = str(summary[key].get("runs_via_declared_path", "")).strip().lower() == "true"
        rows.append({
            "rid": rid, "task": m["task"], "condition": m["condition"], "run_id": m["run_id"],
            "launched": launched,
            "human_pct_first": p1, "human_pct_regrade": p2,
            "abs_diff": None if p1 is None or p2 is None else round(abs(p1 - p2), 1),
            "survived_first": survived(a, w, key, renders_broken),
            "survived_regrade": survived(b, w, key, renders_broken),
            "items_compared": total, "items_agree": agree,
        })

    out = ROOT / "regrade/agreement.csv"
    with out.open("w", newline="", encoding="utf-8") as fh:
        wtr = csv.DictWriter(fh, fieldnames=list(rows[0]))
        wtr.writeheader()
        wtr.writerows(rows)

    def report(label, subset):
        if not subset:
            print(f"\n{label}: no runs")
            return
        keys = {(r["task"], r["condition"], r["run_id"]) for r in subset}
        pairs = [p for k in keys for p in item_pairs[k]]
        ag = sum(r["items_agree"] for r in subset)
        tot = sum(r["items_compared"] for r in subset)
        kap = weighted_kappa(pairs)
        pp = [(r["human_pct_first"], r["human_pct_regrade"]) for r in subset
              if r["human_pct_first"] is not None and r["human_pct_regrade"] is not None]
        icc = icc_a1([a for a, _ in pp], [b for _, b in pp]) if len(pp) > 1 else None
        mad = sum(abs(a - b) for a, b in pp) / len(pp) if pp else None
        sv = [(r["survived_first"], r["survived_regrade"]) for r in subset
              if r["survived_first"] is not None and r["survived_regrade"] is not None]
        sag = sum(1 for a, b in sv if a == b)
        print(f"\n{label}  ({len(subset)} runs, {tot} item comparisons)")
        print(f"  per-item exact agreement   {ag}/{tot} = {100*ag/tot:.1f}%" if tot else "  per-item: none")
        print(f"  linear weighted kappa      {kap:.3f}  ({band(kap)})" if kap is not None else "  kappa: n/a")
        print(f"  ICC(A,1) on human_pct      {icc:.3f}  ({band(icc)})" if icc is not None else "  ICC: n/a")
        print(f"  mean abs difference        {mad:.2f} points" if mad is not None else "  MAD: n/a")
        print(f"  survival call agreement    {sag}/{len(sv)} = {100*sag/len(sv):.1f}%" if sv else "  survival: n/a")

    print(f"wrote {out}   ({len(rows)} runs; {skipped} item comparisons excluded as skip/blank)")
    report("LAUNCHED", [r for r in rows if r["launched"]])
    report("NON-LAUNCHED", [r for r in rows if not r["launched"]])
    report("POOLED", rows)

    dis = sorted((r for r in rows if r["abs_diff"]), key=lambda r: -r["abs_diff"])[:10]
    if dis:
        print("\nlargest human_pct movements (for regrade-report.md):")
        for r in dis:
            print(f"  {r['rid']}  {r['human_pct_first']:5.1f} -> {r['human_pct_regrade']:5.1f}"
                  f"  ({r['abs_diff']:+.1f})  {r['task']}/{r['condition']}/{r['run_id']}")
    flips = [r for r in rows if r["survived_first"] != r["survived_regrade"]]
    if flips:
        print("\nsurvival-call flips:")
        for r in flips:
            print(f"  {r['rid']}  {r['survived_first']} -> {r['survived_regrade']}"
                  f"  {r['task']}/{r['condition']}/{r['run_id']}")


if __name__ == "__main__":
    main()
