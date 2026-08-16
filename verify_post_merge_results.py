#!/usr/bin/env python3
"""
verify_post_merge_results.py -- validate the JOIN produced by merge_results.py.
Reports every discrepancy it finds. Read-only.

merge_results.py is the sole card-scorer; this validator is the check on it. It
deliberately re-implements the scoring rule INDEPENDENTLY (see
recompute_from_card below) so it can catch a bug in merge_results.py's canonical
implementation, not just a stale summary. That non-DRY duplication is the point
(guidelines/pipeline-refactor-design.md, decision 4).

Three check families
--------------------
  1. INTERNAL ARITHMETIC - the human scalar stored in merged_results.jsonl
     equals the weighted sum of that run's visual_items.jsonl map.
       POST_ARITH        human_pct_current != weighted(companion items)
  2. SOURCE FIDELITY - recompute from the card ON DISK and compare to what the
     join wrote. Catches parse/read/scoring errors AND a stale summary (card
     edited but merge_results.py not re-run).
       POST_RECOMPUTE    recompute(card) != merged human_pct_current
       POST_ITEMS        recompute(card) item map != visual_items.jsonl map
  3. REFERENTIAL INTEGRITY - the run sets line up across artifacts, and the
     derived survival column is correctly derived.
       POST_PROBE_NOT_IN_MERGED   a probe row has no merged row
       POST_COMPANION_ORPHAN      a companion row has no merged row
       POST_MERGED_NO_PROBE       merged row says in_results_jsonl but no probe row
       POST_SURVIVAL              runs_via_declared_path != (boot_ok OR
                                  (card_state==graded AND human_pct_current>0))
                                  AND NOT hand-audited frontend launch failure
                                  (frontend-launch-audit.csv, LAUNCH-FAILED rows)
       POST_UNAUDITED_ALLFAIL     a graded all-fail card behind a booted
                                  backend has no adjudication row in
                                  frontend-launch-audit.csv (every such run
                                  must be classified LAUNCH-FAILED or
                                  RENDERS-BROKEN before its survival value
                                  can be trusted)
       POST_SURVIVAL_CARD_DERIVATION  survival recomputed purely from the
                                  human record (card score > 0, or all-fail
                                  adjudicated RENDERS-BROKEN) disagrees with
                                  the stored mechanical derivation; the two
                                  are provably equivalent when grading and
                                  adjudication are complete, so any hit means
                                  a wrong or missing source

Scoring model (matches merge_results.py): pass=1, partial=0.5, fail=0,
skip=excluded, blank/invalid=excluded. human_pct = 100*earned/max_of_graded.

Usage
-----
    python3 verify_post_merge_results.py
    python3 verify_post_merge_results.py --task metrics-dashboard
    python3 verify_post_merge_results.py --summary-only
    python3 verify_post_merge_results.py --csv post-discrepancies.csv

Exit code: 1 if any discrepancy, else 0.
"""
import argparse, collections, json, sys
from pathlib import Path

ROOT_DEFAULT = "/mnt/d/eval-coding-agent-runs"
BATCH_DEFAULT = "batch-20260613"
VALID = {"pass": 1.0, "partial": 0.5, "fail": 0.0, "skip": None}
TOL = 0.11


def norm(t):
    return (t or "").replace("generic:", "")


def key_of_run(run):
    parts = str(run).replace("\\", "/").rstrip("/").split("/")
    if len(parts) >= 4 and parts[-2] == "runs":
        return (parts[-4], parts[-3], parts[-1])
    return None


def load_rubrics(root):
    weights = {}
    rdir = root / "grader" / "rubrics"
    if rdir.is_dir():
        for f in rdir.glob("*.rubric.json"):
            try:
                r = json.loads(f.read_text())
                weights[f.name.replace(".rubric.json", "")] = {
                    it["id"]: it["weight"] for it in r.get("items", [])}
            except Exception:
                pass
    return weights


def load_jsonl(p):
    out = []
    if p.exists():
        for line in p.open(encoding="utf-8", errors="replace"):
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    return out


def recompute_from_card(card, wmap):
    """INDEPENDENT reimplementation of the scoring rule (defense-in-depth).
    Returns (pct_or_None, items_map)."""
    items = (card or {}).get("items") or {}
    earned = total = 0.0
    imap = {}
    for iid, w in (wmap or {}).items():
        raw = str((items.get(iid) or {}).get("score", "")).strip().lower()
        if raw == "" or raw not in VALID:
            continue
        if VALID[raw] is None:
            imap[iid] = "skip"
            continue
        imap[iid] = raw
        earned += VALID[raw] * w
        total += w
    return (round(100 * earned / total, 1) if total else None), imap


def weighted_from_items(imap, wmap):
    earned = total = 0.0
    for iid, sc in (imap or {}).items():
        if sc == "skip" or sc not in VALID:
            continue
        w = (wmap or {}).get(iid)
        if w is None:
            continue
        earned += VALID[sc] * w
        total += w
    return round(100 * earned / total, 1) if total else None


def approx(a, b, tol=TOL):
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    return abs(a - b) <= tol


def as_pct(v):
    """merged stores '' for ungraded; normalise to None or float."""
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def mkey(r):
    return (norm(r.get("task")), r.get("condition"), r.get("run_id"))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=ROOT_DEFAULT)
    ap.add_argument("--batch", default=BATCH_DEFAULT)
    ap.add_argument("--task", help="only verify this task")
    ap.add_argument("--summary-only", action="store_true")
    ap.add_argument("--max-examples", type=int, default=6)
    ap.add_argument("--csv", help="write every discrepancy to this CSV")
    args = ap.parse_args()

    root = Path(args.root)
    bdir = root / "runs" / args.batch
    weights = load_rubrics(root)

    merged_rows = load_jsonl(bdir / "merged_results.jsonl")
    companion_rows = load_jsonl(bdir / "visual_items.jsonl")
    probe_rows = load_jsonl(bdir / "automatic_probes_results.jsonl")

    # same audit file merge_results.py consults for the survival column.
    # launch_dead = LAUNCH-FAILED rows only (they flip survival); audited =
    # every adjudicated run regardless of class, used for the coverage check
    import csv as _csv
    launch_dead = set()
    renders_broken = set()
    audited = set()
    fla = bdir / "frontend-launch-audit.csv"
    if fla.exists():
        for row_ in _csv.DictReader(fla.open(encoding="utf-8", errors="replace")):
            seg = (row_.get("app") or "").replace("\\", "/").split("/")
            if len(seg) >= 4:
                k4 = (seg[0], seg[1], seg[3])
                audited.add(k4)
                st = (row_.get("status") or "").strip().upper()
                if st == "LAUNCH-FAILED":
                    launch_dead.add(k4)
                elif st == "RENDERS-BROKEN":
                    renders_broken.add(k4)
    if not merged_rows:
        sys.exit(f"ERROR: merged_results.jsonl not found or empty under {bdir}")

    merged = {mkey(r): r for r in merged_rows}
    companion = {mkey(r): r for r in companion_rows}
    probe_keys = {k for k in (key_of_run(r.get("run")) for r in probe_rows) if k}

    disc = []
    def flag(code, ident, detail=""):
        disc.append((code, ident, detail))

    def picked(k):
        return (not args.task) or (k[0] == args.task)

    # ---- families 1 & 2: per merged run with a rubric ----
    for k, r in merged.items():
        if not picked(k):
            continue
        task, cond, run_id = k
        wmap = weights.get(task)
        if wmap is None:
            continue
        ident = f"{task}/{cond}/runs/{run_id}"
        stored_h = as_pct(r.get("human_pct_current"))

        card_f = bdir / task / cond / "runs" / run_id / "smoke" / "logs" / "visual-scores.json"
        card = None
        if card_f.is_file():
            try:
                card = json.loads(card_f.read_text())
            except Exception:
                card = None

        # family 2: source fidelity (recompute from the card on disk)
        if card is not None:
            rec_pct, rec_items = recompute_from_card(card, wmap)
            if r.get("card_state") == "graded" or rec_pct is not None or stored_h is not None:
                if not approx(rec_pct, stored_h):
                    flag("POST_RECOMPUTE", ident,
                         f"card->{rec_pct} merged={stored_h} (stale or scoring bug)")
            comp = companion.get(k)
            if comp is not None and (comp.get("items") or {}) != rec_items:
                flag("POST_ITEMS", ident, f"companion={comp.get('items')} card->{rec_items}")

        # family 1: internal arithmetic (companion map vs stored scalar)
        comp = companion.get(k)
        if comp is not None:
            arith = weighted_from_items(comp.get("items") or {}, wmap)
            if not approx(arith, stored_h):
                flag("POST_ARITH", ident, f"weighted(companion)={arith} merged={stored_h}")

        # family 3: survival derivation
        boot_ok = r.get("boot_ok")
        expected = ((boot_ok is True) or
                    (r.get("card_state") == "graded" and (stored_h or 0) > 0)) \
                   and (k not in launch_dead)
        if bool(r.get("runs_via_declared_path")) != bool(expected):
            flag("POST_SURVIVAL", ident,
                 f"stored={r.get('runs_via_declared_path')} expected={expected} "
                 f"(boot_ok={boot_ok}, card_state={r.get('card_state')}, human={stored_h}, "
                 f"launch_audit_dead={k in launch_dead})")

        # audit coverage: a hand-graded ALL-FAIL card behind a booted backend
        # is ambiguous (never-rendered vs renders-but-broken) and must have
        # been adjudicated in frontend-launch-audit.csv under either class.
        # This encodes the card-side boot knowledge as a mandatory cross-check
        # without making free-text notes part of the survival definition.
        if (r.get("card_state") == "graded" and stored_h == 0.0
                and boot_ok is True and k not in audited):
            flag("POST_UNAUDITED_ALLFAIL", ident,
                 "graded all-fail with boot_ok=True but no row in "
                 "frontend-launch-audit.csv (adjudicate: LAUNCH-FAILED or "
                 "RENDERS-BROKEN)")

        # dual derivation: survival recomputed PURELY from the human record
        # (card score + audit adjudication, no boot_ok at all) must equal the
        # stored value. The two derivations are provably equivalent when
        # grading and adjudication are complete; any disagreement means one
        # of the sources is wrong or incomplete. This makes the card-side
        # formulation ("the human record is the outcome of record") an
        # enforced invariant while the mechanical formulation stays the
        # operational definition.
        if r.get("card_state") == "graded":
            card_surv = ((stored_h or 0) > 0) or (k in renders_broken)
            if bool(r.get("runs_via_declared_path")) != card_surv:
                flag("POST_SURVIVAL_CARD_DERIVATION", ident,
                     f"stored={r.get('runs_via_declared_path')} "
                     f"card-only-derivation={card_surv} "
                     f"(human={stored_h}, renders_broken={k in renders_broken})")

    # ---- family 3: referential set integrity ----
    merged_keys = {k for k in merged if picked(k)}
    for k in probe_keys:
        if picked(k) and k not in merged:
            flag("POST_PROBE_NOT_IN_MERGED", f"{k[0]}/{k[1]}/runs/{k[2]}", "probe row has no merged row")
    for k, r in merged.items():
        if picked(k) and r.get("in_results_jsonl") is True and k not in probe_keys:
            flag("POST_MERGED_NO_PROBE", f"{k[0]}/{k[1]}/runs/{k[2]}",
                 "merged says in_results_jsonl but no probe row found")
    for k in companion:
        if picked(k) and k not in merged:
            flag("POST_COMPANION_ORPHAN", f"{k[0]}/{k[1]}/runs/{k[2]}", "companion row has no merged row")

    # ---- report ----
    by_code = collections.Counter(d[0] for d in disc)
    print(f"merged rows : {len(merged)}   companion rows: {len(companion)}   "
          f"probe rows: {len(probe_keys)}"
          + (f"   (task={args.task})" if args.task else ""))
    print(f"discrepancies: {len(disc)}\n")
    if not disc:
        print("  OK  no discrepancies found.")
    else:
        for code in sorted(by_code):
            print(f"  {code:<26} {by_code[code]}")
        if not args.summary_only:
            print("\n--- examples ---")
            shown = collections.Counter()
            for code, ident, detail in disc:
                if shown[code] < args.max_examples:
                    shown[code] += 1
                    print(f"  [{code}] {ident}  {detail}")

    if args.csv:
        import csv
        with open(args.csv, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["code", "run", "detail"])
            w.writerows(disc)
        print(f"\nfull discrepancy list -> {args.csv}")

    return 1 if disc else 0


if __name__ == "__main__":
    sys.exit(main())
