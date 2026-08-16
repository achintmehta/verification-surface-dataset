#!/usr/bin/env python3
"""
stats_mixed_effects.py - the mixed-effects regression cross-check named in
paper/stats-plan.md ("Two cross-checks, reported alongside. ... Second, if the
statsmodels library is available, a standard mixed-effects regression. If the
methods disagree, we say so rather than picking the friendliest.")

This script runs that cross-check for the six primary contrasts (P1-P6). It
adds no new contrasts and touches no data: it reads the same dataset of record
as stats_analysis.py (latest freeze-*/run-summary.csv, plus token counts from
each run's manifest) and fits, per contrast, a standard linear mixed-effects
model:

    outcome ~ treated (+ task fixed effects when the contrast spans tasks)
    with a random intercept per model

The 'treated' coefficient is the tool effect, directly comparable to the
permutation effect in stats-results.txt. For P5 the model is
outcome ~ treated * brownfield and the interaction coefficient is the
difference-in-differences.

Notes, stated once here rather than hedged per line:
- Survival (P2) is a 0/1 outcome fit with a linear mixed model (a linear
  probability model). With survival near ceiling for several models, a
  mixed logistic model would face separation; the linear fit keeps the
  coefficient on the same percentage-point scale as the permutation effect.
- Six models means six random-intercept groups, so the variance component is
  imprecisely estimated. This is a cross-check on the primary permutation
  results, not a replacement for them.
- Regression p-values are two-sided Wald tests; the permutation p-values for
  P1-P4 and P6 are one-sided per the plan. Direction and magnitude are the
  comparison that matters here.
- The fit is deterministic (no resampling), so there is no seed.

Usage:
  pip install statsmodels
  python3 paper/stats_mixed_effects.py > paper/stats-mixed-effects.txt
  python3 paper/stats_mixed_effects.py --root /mnt/d/eval-coding-agent-runs
"""
import argparse, csv, json, math
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels
import statsmodels.formula.api as smf

API_TASKS = ("message-board", "kanban-board", "seat-booking")
VIS_TASKS = ("calendar-week-view", "metrics-dashboard")

# Transcribed from paper/stats-results.txt, printed alongside for comparison.
PERMUTATION_REFERENCE = {
    "P1": ("+12.26", "[+7.04, +17.47]"),
    "P2": ("+0.13",  "[+0.10, +0.16]"),
    "P3": ("+0.80",  "[+0.73, +0.87]"),
    "P4": ("+6.88",  "[+0.83, +13.41]"),
    "P5": ("-0.67",  "[-13.67, +12.67]"),
    "P6": ("+15.33", "[+7.33, +24.00]"),
}


def fnum(x):
    try:
        return float(x)
    except Exception:
        return None


def load(root, batch):
    """Identical data source and derivations to stats_analysis.py's load()."""
    freezes = sorted(root.glob("freeze-*/run-summary.csv"))
    f = freezes[-1] if freezes else root / "runs" / batch / "run-summary.csv"
    print(f"dataset of record: {f}")
    rows = list(csv.DictReader(f.open(encoding="utf-8")))
    out = []
    for r in rows:
        mf = (root / "runs" / batch / r["task"] / r["condition"] / "runs" /
              r["run_id"] / "smoke" / "logs" / "manifest.json")
        tokens = None
        try:
            m = json.loads(mf.read_text(errors="replace"))
            if isinstance(m.get("total_tokens_used"), dict):
                tokens = m["total_tokens_used"].get("total_tokens")
        except Exception:
            pass
        out.append(dict(
            task=r["task"], cond=r["condition"],
            model=(r["model"] or "?").replace("-anthropic", ""),
            functional=fnum(r["functional_pct"]),
            human=fnum(r["human_pct_current"]),
            survival=1.0 if r["runs_via_declared_path"] == "True" else 0.0,
            ltok=math.log(tokens) if tokens else None))
    return pd.DataFrame(out)


def subset(df, a, b, outcome, tasks):
    d = df[df["cond"].isin([a, b])].copy()
    if tasks:
        d = d[d["task"].isin(tasks)]
    d = d[d[outcome].notna()].copy()
    d["treated"] = (d["cond"] == a).astype(float)
    d["y"] = d[outcome].astype(float)
    return d


def fit_lmm(d, formula):
    """Fit MixedLM with a random intercept per model; fall back from the
    default optimizer only if it fails to converge."""
    model = smf.mixedlm(formula, d, groups=d["model"])
    try:
        res = model.fit(reml=True)
        if not res.converged:
            raise RuntimeError("not converged")
    except Exception:
        res = model.fit(reml=True, method="powell", maxiter=2000)
    return res


def report(tag, label, a, b, outcome, res, coef_name, n, extra=""):
    coef = res.params[coef_name]
    se = res.bse[coef_name]
    p = res.pvalues[coef_name]
    lo, hi = res.conf_int().loc[coef_name]
    ref_eff, ref_ci = PERMUTATION_REFERENCE[tag]
    print(f"\n{tag} {label}")
    print(f"  {a} - {b} on {outcome}  (n={n}){extra}")
    print(f"  mixed-effects estimate = {coef:+.2f}  SE = {se:.2f}  "
          f"95% CI [{lo:+.2f}, {hi:+.2f}]  two-sided p = {p:.4f}")
    print(f"  permutation reference  = {ref_eff}  95% CI {ref_ci}  "
          f"(stats-results.txt)")
    rand_var = float(res.cov_re.iloc[0, 0]) if res.cov_re.size else float("nan")
    print(f"  random intercept (model) variance = {rand_var:.2f}  "
          f"residual variance = {res.scale:.2f}")
    print(f"  converged = {res.converged}")
    return coef, p


def run_simple(df, tag, label, a, b, outcome, tasks):
    d = subset(df, a, b, outcome, tasks)
    if d.empty or d["treated"].nunique() < 2:
        print(f"\n{tag} {label}\n  SKIPPED: no usable rows for outcome "
              f"'{outcome}' (token manifests absent?)")
        return None
    multi_task = d["task"].nunique() > 1
    formula = "y ~ treated + C(task)" if multi_task else "y ~ treated"
    res = fit_lmm(d, formula)
    extra = "  [task fixed effects included]" if multi_task else ""
    return report(tag, label, a, b, outcome, res, "treated", len(d), extra)


def run_did(df, tag, label, task_bf, task_gf, outcome):
    d = subset(df, "execution", "no_verification", outcome, (task_bf, task_gf))
    d["brownfield"] = (d["task"] == task_bf).astype(float)
    res = fit_lmm(d, "y ~ treated * brownfield")
    return report(tag, label, "(bf gap)", "(gf gap)", outcome, res,
                  "treated:brownfield", len(d),
                  "  [difference-in-differences: interaction coefficient]")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="/mnt/d/eval-coding-agent-runs")
    ap.add_argument("--batch", default="batch-20260613")
    a = ap.parse_args()
    df = load(Path(a.root), a.batch)
    print(f"stats_mixed_effects.py per stats-plan.md cross-check | "
          f"statsmodels {statsmodels.__version__}")
    print(f"n={len(df)} runs | tokens present for {df['ltok'].notna().sum()}")
    print("\n========== MIXED-EFFECTS CROSS-CHECK: PRIMARY CONTRASTS ==========")
    print("model per contrast: y ~ treated (+ task fixed effects), "
          "random intercept per model; REML")

    results = {}
    results["P1"] = run_simple(df, "P1", "depth", "execution",
                               "no_verification", "functional", API_TASKS)
    results["P2"] = run_simple(df, "P2", "cheap signal (survival)",
                               "boot_check", "no_verification", "survival", None)
    results["P3"] = run_simple(df, "P3", "cost (log tokens)", "execution",
                               "no_verification", "ltok", None)
    results["P4"] = run_simple(df, "P4", "sight", "visual", "execution",
                               "human", VIS_TASKS)
    results["P5"] = run_did(df, "P5", "brownfield DiD",
                            "kanban-labels-brownfield", "kanban-board",
                            "functional")
    results["P6"] = run_simple(df, "P6", "budgets", "execution",
                               "no_verification", "human",
                               ("log-explorer-perf",))

    print("\n========== AGREEMENT SUMMARY ==========")
    print("(sign agreement vs the permutation effect; two-sided p at 0.05)")
    for tag, r in results.items():
        if r is None:
            print(f"  {tag}: skipped")
            continue
        coef, p = r
        ref = float(PERMUTATION_REFERENCE[tag][0])
        same_sign = (coef == 0 and ref == 0) or (coef * ref > 0) or \
                    (abs(ref) < 1e-9 and abs(coef) < 1e-9)
        print(f"  {tag}: estimate {coef:+.2f} vs permutation {ref:+.2f}  "
              f"same direction = {'yes' if same_sign else 'NO'}  "
              f"regression p = {p:.4f}")


if __name__ == "__main__":
    main()
