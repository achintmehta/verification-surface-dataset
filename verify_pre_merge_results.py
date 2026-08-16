#!/usr/bin/env python3
"""
verify_pre_merge_results.py -- validate the pre-merge INPUTS before the join
(merge_results.py). Reports every discrepancy it finds. Read-only.

It validates two things:
  1. automatic_probes_results.jsonl (machine grades): structure, functional
     arithmetic, duplicates, path<->field agreement, missing run dirs.
  2. the human/visual CARDS (visual-scores.json): completeness AND validity.
     ALL manual/visual grading verification lives here per the completeness /
     verification split (guidelines/pipeline-refactor-design.md);
     check_probe_completeness.py handles only automatic-probe presence.

Because the machine output is now machine-only (no visual_pct / visual_items /
overall_pct), the old stored-vs-card visual checks are gone: there is nothing
merged into the jsonl to go stale (VISUAL_UNMERGED / VISUAL_RECOMPUTE retired).
Instead the cards are validated directly, on disk, before scoring.

Scoring model (for card recompute / validity; matches merge_results.py)
-----------------------------------------------------------------------
  pass=1, partial=0.5, fail=0, skip=excluded, blank/invalid=excluded.
  functional_pct = round(100 * functional_score / functional_max, 1)

Checks (each emits a discrepancy row with a CODE)
-------------------------------------------------
  probe rows (automatic_probes_results.jsonl):
    CORRUPT_LINE       a line isn't valid JSON (e.g. NUL bytes)
    DUP_RUN            more than one row for the same run
    MISSING_RUN_DIR    row.run does not exist on disk
    PATH_TASK_MISMATCH task field != the task segment of run path
    PATH_COND_MISMATCH condition field != the condition segment of run path
    FUNCTIONAL_ARITH   functional_pct != 100*functional_score/functional_max
  cards (visual-scores.json) -- ALL manual/visual verification:
    CARD_NO_CARD       run has a rubric but no card (only when enforcing)
    CARD_UNPARSEABLE   card JSON is broken
    CARD_BLANK         no items scored (only when enforcing that condition)
    CARD_PARTIAL       some but not all items scored (only when enforcing)
    GRADED_BY_MISSING  all items scored but grader_name empty (when enforcing)
    CARD_BAD_SCORE     card item score not in {pass,partial,fail,skip,""}
    CARD_UNKNOWN_ITEM  card scores an item id not in the rubric

Completeness scope: by default every run whose task has a rubric is required to
have a complete card. Narrow with --card-conditions (e.g. 'visual' for API
tasks whose only human-graded arm is the visual one). Autofilled cards
(grader_name starting 'auto:') always pass completeness. Validity codes fire
for any card regardless of scope.

Usage
-----
    python3 verify_pre_merge_results.py                     # verify everything
    python3 verify_pre_merge_results.py --task log-explorer-perf
    python3 verify_pre_merge_results.py --card-conditions visual
    python3 verify_pre_merge_results.py --summary-only
    python3 verify_pre_merge_results.py --csv discrepancies.csv
    python3 verify_pre_merge_results.py --results some/other/automatic_probes_results.jsonl

Read-only: never writes to the results file or the runs.
"""

import argparse
import collections
import json
import re
import sys
from pathlib import Path

ROOT_DEFAULT = "/mnt/d/eval-coding-agent-runs"
BATCH_DEFAULT = "batch-20260613"
VALID = {"pass": 1.0, "partial": 0.5, "fail": 0.0, "skip": None}
TOL = 0.11


def norm_task(t):
    return (t or "").replace("generic:", "")


def resolve_run(run, root: Path):
    """run may be absolute (/mnt/d/...) or relative (runs/...)."""
    s = str(run)
    s = s.replace("/mnt/d/eval-coding-agent-runs", str(root))
    p = Path(s)
    return p if p.is_absolute() else (root / s)


def load_rubrics(root: Path):
    weights = {}
    rdir = root / "grader" / "rubrics"
    if not rdir.is_dir():
        return weights
    for f in rdir.glob("*.rubric.json"):
        try:
            r = json.loads(f.read_text())
            task = f.name.replace(".rubric.json", "")
            weights[task] = {it["id"]: it["weight"] for it in r.get("items", [])}
        except Exception:
            pass
    return weights


def score_card(card, wmap):
    """Recompute visual_pct from a card + rubric weights.
    Returns (pct_or_None, graded_items_dict, unknown_ids, bad_scores)."""
    items_in = card.get("items") or {}
    got = gmax = 0.0
    graded = {}
    bad_scores = []
    for iid, cell in items_in.items():
        sc = str((cell or {}).get("score", "")).strip().lower()
        if sc and sc not in VALID:
            bad_scores.append((iid, sc))
    unknown = [iid for iid in items_in if iid not in wmap]
    for iid, w in wmap.items():
        sc = str(((items_in.get(iid)) or {}).get("score", "")).strip().lower()
        if sc == "" or sc not in VALID:
            continue
        if VALID[sc] is None:
            graded[iid] = "skip"
            continue
        got += VALID[sc] * w
        gmax += w
        graded[iid] = sc
    pct = round(100 * got / gmax, 1) if gmax else None
    return pct, graded, unknown, bad_scores


def card_stats(card, wmap):
    """Weighted + raw score breakdown for one card, matching the grader.
    pass=1, partial=0.5, fail=0, skip=excluded. Returns earned/max/pct (weighted
    %pass), pass/partial/fail/skip counts, gradable count, and raw %pass
    (pass count / gradable)."""
    _, graded, _, _ = score_card(card, wmap)
    counts = {"pass": 0, "partial": 0, "fail": 0, "skip": 0}
    earned = mx = 0.0
    for iid, sc in graded.items():
        counts[sc] = counts.get(sc, 0) + 1
        if sc != "skip":
            earned += VALID[sc] * wmap[iid]
            mx += wmap[iid]
    gradable = counts["pass"] + counts["partial"] + counts["fail"]
    return {"earned": earned, "max": mx,
            "pct": round(100 * earned / mx, 1) if mx else None,
            "raw_pass_pct": round(100 * counts["pass"] / gradable, 1) if gradable else None,
            "gradable": gradable, **counts}


def list_scores(rows, weights, root, args):
    import csv as _csv
    base = root / "runs" / args.batch
    per_task = collections.defaultdict(lambda: {"earned": 0.0, "max": 0.0, "pcts": [], "n": 0, "nocard": 0})
    out = []
    for _lineno, r in rows:
        task = norm_task(r.get("task"))
        if args.task and task != args.task:
            continue
        run = r.get("run", "")
        wmap = weights.get(task)
        card_f = resolve_run(run, root) / "smoke" / "logs" / "visual-scores.json"
        st = None
        if wmap is not None and card_f.is_file():
            try:
                st = card_stats(json.loads(card_f.read_text()), wmap)
            except Exception:
                st = None
        d = per_task[task]
        if st is None:
            d["nocard"] += 1
        else:
            d["earned"] += st["earned"]; d["max"] += st["max"]
            if st["pct"] is not None:
                d["pcts"].append(st["pct"]); d["n"] += 1
        out.append((task, run, st))

    if not args.summary_only:
        for task, run, st in out:
            try:
                rel = str(resolve_run(run, root).relative_to(base))
            except Exception:
                rel = str(run)
            if st is None:
                print(f"  {rel:<48}  (no card)")
            else:
                print(f"  {rel:<48}  {st['earned']:g}/{st['max']:g} = {str(st['pct']):>5}%   "
                      f"pass {st['pass']}/{st['gradable']}  "
                      f"(partial {st['partial']}, fail {st['fail']}, skip {st['skip']})")

    print("\n--- per task (weighted %pass = sum earned / sum max; pass=1, partial=0.5, fail=0) ---")
    tot_e = tot_m = 0.0
    tot_pcts = []
    for task in sorted(per_task):
        d = per_task[task]
        tot_e += d["earned"]; tot_m += d["max"]; tot_pcts += d["pcts"]
        wpct = round(100 * d["earned"] / d["max"], 1) if d["max"] else None
        mpct = round(sum(d["pcts"]) / len(d["pcts"]), 1) if d["pcts"] else None
        print(f"  {task:<26} cards={d['n']:>3}  weighted={wpct}%  mean_of_runs={mpct}%"
              + (f"  (no-card {d['nocard']})" if d["nocard"] else ""))
    if tot_m:
        print(f"\n  OVERALL  weighted %pass = {round(100 * tot_e / tot_m, 1)}%   "
              f"mean per-run = {round(sum(tot_pcts) / len(tot_pcts), 1) if tot_pcts else None}%   "
              f"cards scored = {len(tot_pcts)}")

    if args.scores_csv:
        with open(args.scores_csv, "w", newline="", encoding="utf-8") as f:
            w = _csv.writer(f)
            w.writerow(["app", "task", "earned", "max", "pct", "pass", "partial",
                        "fail", "skip", "gradable", "raw_pass_pct"])
            for task, run, st in out:
                try:
                    rel = str(resolve_run(run, root).relative_to(base))
                except Exception:
                    rel = str(run)
                if st is None:
                    w.writerow([rel, task, "", "", "", "", "", "", "", "", ""])
                else:
                    w.writerow([rel, task, f"{st['earned']:g}", f"{st['max']:g}", st["pct"],
                                st["pass"], st["partial"], st["fail"], st["skip"],
                                st["gradable"], st["raw_pass_pct"]])
        print(f"\n  per-run scores CSV -> {args.scores_csv}")
    return 0


def read_lines(path: Path):
    """Yield (lineno, obj_or_None, raw). obj is None if the line isn't JSON."""
    with open(path, "rb") as fh:
        for i, raw in enumerate(fh, 1):
            had_nul = b"\x00" in raw
            # drop NUL padding / decode leniently
            txt = raw.replace(b"\x00", b"").decode("utf-8", "replace").strip()
            if not txt:
                if had_nul:
                    yield i, None, raw          # corruption padding -> flag it
                continue
            try:
                yield i, json.loads(txt), raw
            except Exception:
                yield i, None, raw


def approx(a, b, tol=TOL):
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    return abs(a - b) <= tol


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=ROOT_DEFAULT)
    ap.add_argument("--batch", default=BATCH_DEFAULT)
    ap.add_argument("--results", help="path to the probe jsonl "
                    "(default: <root>/runs/<batch>/automatic_probes_results.jsonl)")
    ap.add_argument("--task", help="only verify this task")
    ap.add_argument("--card-conditions", default="",
                    help="comma-separated conditions whose cards must be COMPLETE "
                         "(e.g. 'visual'); empty = require complete cards for every "
                         "run that has a rubric. Validity checks always run.")
    ap.add_argument("--summary-only", action="store_true")
    ap.add_argument("--max-examples", type=int, default=6)
    ap.add_argument("--csv", help="write every discrepancy to this CSV")
    ap.add_argument("--list-scores", action="store_true",
                    help="instead of verifying, list per-run visual scores from "
                         "visual-scores.json (pass/total, weighted score, percent-pass) "
                         "plus per-task and overall means")
    ap.add_argument("--scores-csv", help="with --list-scores: write the per-run table to CSV")
    args = ap.parse_args()

    root = Path(args.root)
    results_f = (Path(args.results) if args.results
                 else root / "runs" / args.batch / "automatic_probes_results.jsonl")
    if not results_f.exists():
        sys.exit(f"ERROR: probe results file not found: {results_f}")
    card_conds = {c.strip() for c in args.card_conditions.split(",") if c.strip()}

    weights = load_rubrics(root)
    disc = []                       # (code, run/line, detail)
    def flag(code, ident, detail=""):
        disc.append((code, ident, detail))

    rows = []
    for lineno, obj, raw in read_lines(results_f):
        if obj is None:
            n_nul = raw.count(b"\x00")
            flag("CORRUPT_LINE", f"line {lineno}",
                 f"{len(raw)} bytes, {n_nul} NUL" if n_nul else f"{len(raw)} bytes not JSON")
            continue
        rows.append((lineno, obj))

    if args.list_scores:
        return list_scores(rows, weights, root, args)

    # duplicate runs
    seen = collections.Counter(o["run"] for _, o in rows if "run" in o)
    dup_reported = set()

    checked = 0
    for lineno, r in rows:
        task = norm_task(r.get("task"))
        if args.task and task != args.task:
            continue
        checked += 1
        run = r.get("run", f"<line {lineno}>")

        # duplicates
        if seen.get(run, 0) > 1 and run not in dup_reported:
            dup_reported.add(run)
            flag("DUP_RUN", run, f"{seen[run]} rows for this run")

        # path <-> fields
        m = re.search(r"/([^/]+)/([^/]+)/runs/([^/]+)/?$", str(run))
        if m:
            ptask, pcond = m.group(1), m.group(2)
            if ptask != task:
                flag("PATH_TASK_MISMATCH", run, f"field={task} path={ptask}")
            if r.get("condition") and r.get("condition") != pcond:
                flag("PATH_COND_MISMATCH", run, f"field={r.get('condition')} path={pcond}")

        run_dir = resolve_run(run, root)
        if not run_dir.is_dir():
            flag("MISSING_RUN_DIR", run, str(run_dir))

        # functional arithmetic (machine output carries no visual/overall now)
        fs, fm, fp = r.get("functional_score"), r.get("functional_max"), r.get("functional_pct")
        if fm:
            exp = round(100 * fs / fm, 1)
            if fp is not None and not approx(exp, fp):
                flag("FUNCTIONAL_ARITH", run, f"stored={fp} expected={exp}")

        # ---- manual/visual card verification (completeness + validity) ----
        wmap = weights.get(task)
        if wmap is None:
            continue                                  # no rubric => no card expected

        cond = r.get("condition", "")
        enforce = (not card_conds) or (cond in card_conds)

        card_f = run_dir / "smoke" / "logs" / "visual-scores.json"
        if not card_f.is_file():
            if enforce:
                flag("CARD_NO_CARD", run, "task has a rubric but no visual-scores.json")
            continue
        try:
            card = json.loads(card_f.read_text())
        except Exception as e:
            flag("CARD_UNPARSEABLE", run, str(e)[:80])
            continue

        # validity: always, for any card
        _, graded, unknown, bad = score_card(card, wmap)
        for iid, sc in bad:
            flag("CARD_BAD_SCORE", run, f"{iid}={sc!r}")
        for iid in unknown:
            flag("CARD_UNKNOWN_ITEM", run, iid)

        # completeness: only for the conditions being enforced
        if enforce:
            gname = (card.get("grader_name") or "").strip()
            all_scores = [str((c or {}).get("score", "")).strip()
                          for c in (card.get("items") or {}).values()]
            n_scored = sum(1 for s in all_scores if s)
            if gname.startswith("auto:"):
                pass                                  # autofilled non-booting rule: OK
            elif n_scored == 0:
                flag("CARD_BLANK", run, "no items scored")
            elif n_scored < len(all_scores):
                flag("CARD_PARTIAL", run, f"{n_scored}/{len(all_scores)} items scored")
            elif not gname:
                flag("GRADED_BY_MISSING", run, "all items scored but grader_name empty")

    # ---- report ----
    by_code = collections.Counter(d[0] for d in disc)
    print(f"results file : {results_f}")
    print(f"rows parsed  : {len(rows)}   verified: {checked}"
          + (f"   (task={args.task})" if args.task else ""))
    print(f"discrepancies: {len(disc)}\n")

    if not disc:
        print("  ✓ no discrepancies found.")
    else:
        for code in sorted(by_code):
            print(f"  {code:<20} {by_code[code]}")
        if not args.summary_only:
            print("\n--- examples ---")
            shown = collections.Counter()
            for code, ident, detail in disc:
                if shown[code] < args.max_examples:
                    shown[code] += 1
                    who = ident.replace(str(root) + "/runs/" + args.batch + "/", "") \
                        if isinstance(ident, str) else ident
                    print(f"  [{code}] {who}  {detail}")
            more = {c: by_code[c] - shown[c] for c in by_code if by_code[c] > shown[c]}
            if more:
                print("  ... (+" + ", ".join(f"{v} {c}" for c, v in more.items()) + ")")

    # per-task row counts (a quick sanity read)
    print("\n--- rows per task ---")
    tc = collections.Counter(norm_task(o.get("task")) for _, o in rows)
    uc = collections.Counter()
    seenset = collections.defaultdict(set)
    for _, o in rows:
        t = norm_task(o.get("task"))
        seenset[t].add(o.get("run"))
    for t in sorted(tc):
        dupflag = "  <-- has duplicates" if len(seenset[t]) != tc[t] else ""
        print(f"  {t:<28} rows={tc[t]:<4} unique_runs={len(seenset[t])}{dupflag}")

    if args.csv:
        import csv
        with open(args.csv, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["code", "run_or_line", "detail"])
            w.writerows(disc)
        print(f"\nfull discrepancy list -> {args.csv}")

    return 1 if disc else 0


if __name__ == "__main__":
    sys.exit(main())
