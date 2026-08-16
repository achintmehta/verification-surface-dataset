#!/usr/bin/env python3
"""
stats_analysis.py - implements paper/stats-plan.md exactly. Do not add contrasts
here without adding them to the plan as 'exploratory' first.

Usage:
  python3 paper/stats_analysis.py > paper/stats-results.txt
"""
import argparse, csv, json, math, random, statistics as st
from collections import defaultdict
from pathlib import Path

SEED = 20260703
N_PERM = 10_000
N_BOOT = 5_000
API_TASKS = ("message-board", "kanban-board", "seat-booking")
VIS_TASKS = ("calendar-week-view", "metrics-dashboard")


def fnum(x):
    try:
        return float(x)
    except Exception:
        return None


def load(root, batch):
    # dataset of record: the LATEST sealed freeze (folder names are dated
    # freeze-YYYYMMDD, so lexicographic max = newest). Superseded freezes are
    # kept for provenance and never read. Falls back to the live batch table
    # only when no freeze exists. The chosen source is printed into the
    # output for provenance.
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
            ltok=math.log(tokens) if tokens else None,
            shots=fnum(r["screenshot_calls"]) or 0))
    return out


# ------------------------------------------------------------ machinery -----
def strata(rows, a, b, outcome, tasks=None):
    """{(model,task): ([A values],[B values])} for strata containing both arms."""
    s = defaultdict(lambda: ([], []))
    for r in rows:
        if tasks and r["task"] not in tasks:
            continue
        v = r[outcome]
        if v is None:
            continue
        if r["cond"] == a:
            s[(r["model"], r["task"])][0].append(v)
        elif r["cond"] == b:
            s[(r["model"], r["task"])][1].append(v)
    return {k: v for k, v in s.items() if v[0] and v[1]}


def diff_of_means(s):
    """Stratum-weighted mean(A) - mean(B); weights = stratum run counts."""
    num = den = 0.0
    for va, vb in s.values():
        w = len(va) + len(vb)
        num += w * (st.mean(va) - st.mean(vb))
        den += w
    return num / den if den else float("nan")


def perm_test(s, rng, sided):
    obs = diff_of_means(s)
    hits = 0
    for _ in range(N_PERM):
        ps = {}
        for k, (va, vb) in s.items():
            pool = va + vb
            rng.shuffle(pool)
            ps[k] = (pool[:len(va)], pool[len(va):])
        d = diff_of_means(ps)
        if sided == "greater":
            hits += d >= obs
        elif sided == "less":
            hits += d <= obs
        else:
            hits += abs(d) >= abs(obs)
    return obs, (hits + 1) / (N_PERM + 1)


def boot_ci(s, rng):
    reps = []
    for _ in range(N_BOOT):
        bs = {k: ([rng.choice(va) for _ in va], [rng.choice(vb) for _ in vb])
              for k, (va, vb) in s.items()}
        reps.append(diff_of_means(bs))
    reps.sort()
    return reps[int(.025 * N_BOOT)], reps[int(.975 * N_BOOT)]


def per_model(s):
    agg = defaultdict(lambda: ([], []))
    for (m, t), (va, vb) in s.items():
        agg[m][0].extend(va)
        agg[m][1].extend(vb)
    return {m: round(st.mean(va) - st.mean(vb), 1) for m, (va, vb) in agg.items()}


def wilcoxon_sign(diffs):
    """Exact sign-test p (two-sided) over model-level differences (n<=6)."""
    d = [x for x in diffs if x != 0]
    n = len(d)
    if n == 0:
        return 1.0
    k = sum(1 for x in d if x > 0)
    from math import comb
    p = sum(comb(n, i) for i in range(min(k, n - k) + 1)) / 2 ** n * 2
    return min(p, 1.0)


def run_contrast(rows, rng, label, a, b, outcome, tasks, sided):
    s = strata(rows, a, b, outcome, tasks)
    obs, p = perm_test(s, rng, sided)
    lo, hi = boot_ci(s, rng)
    pm = per_model(s)
    sign_p = wilcoxon_sign(list(pm.values()))
    n = sum(len(va) + len(vb) for va, vb in s.values())
    return dict(label=label, a=a, b=b, outcome=outcome, n=n, obs=obs,
                lo=lo, hi=hi, p=p, sign_p=sign_p, per_model=pm)


def did_test(rows, rng, task_a, task_b, outcome):
    """P5: (exec-no_ver gap on task_a) - (same gap on task_b), permutation within
    model x task strata, two-sided."""
    def build():
        return {t: strata(rows, "execution", "no_verification", outcome, (t,))
                for t in (task_a, task_b)}
    base = build()
    obs = diff_of_means(base[task_a]) - diff_of_means(base[task_b])
    hits = 0
    for _ in range(N_PERM):
        d = []
        for t in (task_a, task_b):
            ps = {}
            for k, (va, vb) in base[t].items():
                pool = va + vb
                rng.shuffle(pool)
                ps[k] = (pool[:len(va)], pool[len(va):])
            d.append(diff_of_means(ps))
        hits += abs(d[0] - d[1]) >= abs(obs)
    # bootstrap CI
    reps = []
    for _ in range(N_BOOT):
        d = []
        for t in (task_a, task_b):
            bs = {k: ([rng.choice(va) for _ in va], [rng.choice(vb) for _ in vb])
                  for k, (va, vb) in base[t].items()}
            d.append(diff_of_means(bs))
        reps.append(d[0] - d[1])
    reps.sort()
    return obs, (hits + 1) / (N_PERM + 1), reps[int(.025 * N_BOOT)], reps[int(.975 * N_BOOT)]


def holm(ps):
    order = sorted(range(len(ps)), key=lambda i: ps[i])
    adj = [0.0] * len(ps)
    mx = 0.0
    for rank, i in enumerate(order):
        val = min(1.0, (len(ps) - rank) * ps[i])
        mx = max(mx, val)
        adj[i] = mx
    return adj


def show(c, holm_p=None):
    print(f"\n{c['label']}")
    print(f"  {c['a']} - {c['b']} on {c['outcome']}  (n={c['n']})")
    print(f"  effect = {c['obs']:+.2f}  95% CI [{c['lo']:+.2f}, {c['hi']:+.2f}]"
          f"  perm p = {c['p']:.4f}"
          + (f"  Holm p = {holm_p:.4f}" if holm_p is not None else "")
          + f"  sign-test p = {c['sign_p']:.3f}")
    print("  per-model: " + "  ".join(f"{m}={d:+.1f}" for m, d in sorted(c["per_model"].items())))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="/mnt/d/eval-coding-agent-runs")
    ap.add_argument("--batch", default="batch-20260613")
    a = ap.parse_args()
    root = Path(a.root)
    rng = random.Random(SEED)
    rows = load(root, a.batch)
    print(f"stats_analysis.py per stats-plan.md | seed={SEED} perms={N_PERM} boots={N_BOOT}")
    print(f"n={len(rows)} runs | tokens present for "
          f"{sum(1 for r in rows if r['ltok'] is not None)}")

    # ---------------- primaries P1-P6 ----------------
    print("\n================ PRIMARY CONTRASTS (Holm family) ================")
    P = []
    P.append(run_contrast(rows, rng, "P1 depth", "execution", "no_verification",
                          "functional", API_TASKS, "greater"))
    P.append(run_contrast(rows, rng, "P2 cheap signal (survival)", "boot_check",
                          "no_verification", "survival", None, "greater"))
    P.append(run_contrast(rows, rng, "P3 cost (log tokens)", "execution",
                          "no_verification", "ltok", None, "greater"))
    P.append(run_contrast(rows, rng, "P4 sight", "visual", "execution",
                          "human", VIS_TASKS, "greater"))
    d, p5p, lo5, hi5 = did_test(rows, rng, "kanban-labels-brownfield", "kanban-board",
                                "functional")
    P5 = dict(label="P5 brownfield DiD", a="(bf gap)", b="(gf gap)",
              outcome="functional", n="paired", obs=d, lo=lo5, hi=hi5, p=p5p,
              sign_p=float("nan"), per_model={})
    P.append(P5)
    P.append(run_contrast(rows, rng, "P6 budgets", "execution", "no_verification",
                          "human", ("log-explorer-perf",), "greater"))
    hp = holm([c["p"] for c in P])
    for c, h in zip(P, hp):
        if c["per_model"]:
            show(c, h)
        else:
            print(f"\n{c['label']}\n  effect = {c['obs']:+.2f}  "
                  f"95% CI [{c['lo']:+.2f}, {c['hi']:+.2f}]  perm p = {c['p']:.4f}  Holm p = {h:.4f}")

    # ---------------- secondaries ----------------
    print("\n================ SECONDARY CONTRASTS (uncorrected) ================")
    show(run_contrast(rows, rng, "S1 cheap-signal shortfall", "execution",
                      "boot_check", "functional", API_TASKS, "two"))
    show(run_contrast(rows, rng, "S2 channel decomposition", "visual_no_shell",
                      "execution", "human", VIS_TASKS, "two"))
    show(run_contrast(rows, rng, "S3 sight on measured task", "visual",
                      "execution", "human", ("log-explorer-perf",), "two"))
    show(run_contrast(rows, rng, "S4a linter null (functional)", "static",
                      "no_verification", "functional", API_TASKS, "two"))
    show(run_contrast(rows, rng, "S4b linter null (survival)", "static",
                      "no_verification", "survival", None, "two"))
    show(run_contrast(rows, rng, "S5 behavioral vs shell", "behavioral",
                      "execution", "functional", ("seat-booking",), "two"))

    print("\nS6 per-model H4 (visual - execution, human, per venue; perm p per model)")
    for task in VIS_TASKS:
        print(f"  -- {task} --")
        for m in sorted({r["model"] for r in rows}):
            sub = [r for r in rows if r["model"] == m]
            s = strata(sub, "visual", "execution", "human", (task,))
            if not s:
                continue
            obs, p = perm_test(s, rng, "two")
            sh = sum(r["shots"] for r in sub if r["task"] == task and r["cond"] == "visual")
            print(f"    {m:22s} diff={obs:+6.1f}  p={p:.3f}  screenshots={sh:.0f}")

    # ---------------- appendix F ----------------
    print("\n================ APPENDIX F: per-cell mean / SD / n ================")
    for outcome in ("functional", "human", "survival"):
        print(f"\n--- {outcome} ---")
        cells = defaultdict(list)
        for r in rows:
            if r[outcome] is not None:
                cells[(r["task"], r["cond"])].append(r[outcome])
        for (t, c), v in sorted(cells.items()):
            sd = st.pstdev(v) if len(v) > 1 else 0.0
            print(f"  {t:26s} {c:22s} n={len(v):3d}  mean={st.mean(v):6.1f}  sd={sd:5.1f}")


if __name__ == "__main__":
    main()
