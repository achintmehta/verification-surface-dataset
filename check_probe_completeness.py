#!/usr/bin/env python3
"""
check_probe_completeness.py - AUTOMATIC-probe completeness audit.

Answers one question only: does every run that exists on disk have a machine
grade (a row in automatic_probes_results.jsonl)? It touches NO scorecards and
does NO human/visual grading checks - all manual/visual verification (card
completeness AND validity) lives in verify_pre_merge_results.py per the
completeness/verification split (guidelines/pipeline-refactor-design.md).

What it checks
--------------
  - every <task>/<cond>/runs/<n> directory containing app/ has a probe row
  - (per row present) whether the run booted, for a quick readiness read

Output schema  (runs/<batch>/completeness_report.csv, one row per run on disk)
-----------------------------------------------------------------------------
  task            task name
  condition       condition name
  run_id          run folder name
  model           from the probe row, or '' if no row
  probe_present   True|False  (row exists in automatic_probes_results.jsonl)
  run_status      from the probe row, or '' if absent
  boot_ok         True|False|'' (from the probe row)

Exit code: 0 if every run on disk has a probe row, else 1.

Usage:
  python3 check_probe_completeness.py
  python3 check_probe_completeness.py --task calendar-week-view
  python3 check_probe_completeness.py --root /mnt/d/eval-coding-agent-runs --batch batch-20260613
"""
import argparse, csv, json, sys
from pathlib import Path


def load_probe_rows(results_f):
    """Key every automatic-probe row by (task, condition, run_id)."""
    rows = {}
    if not results_f.exists():
        return rows
    for line in results_f.open(encoding="utf-8", errors="replace"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        parts = r.get("run", "").replace("\\", "/").rstrip("/").split("/")
        if len(parts) >= 4 and parts[-2] == "runs":
            rows[(parts[-4], parts[-3], parts[-1])] = r
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="/mnt/d/eval-coding-agent-runs")
    ap.add_argument("--batch", default="batch-20260613")
    ap.add_argument("--task", help="only audit this task")
    a = ap.parse_args()
    bdir = Path(a.root) / "runs" / a.batch
    probes_f = bdir / "automatic_probes_results.jsonl"
    if not probes_f.exists():
        sys.exit(
            f"ERROR: {probes_f} does not exist.\n"
            "This is NOT a signal to re-grade anything. The machine grades "
            "almost certainly already exist in the legacy file "
            "(freeze-20260703/results.jsonl, the legacy pre-refactor file); "
            "the refactored pipeline just "
            "reads them under the new name. Run the one-time migration "
            "snippet in guidelines/refactor-verification-report.md (strips "
            "the four human/visual fields from the legacy file), then re-run "
            "this check. Only genuinely NEW runs are graded with "
            "automatic_probes.py.")
    probes = load_probe_rows(probes_f)

    out_rows, missing = [], []
    for task_dir in sorted(p for p in bdir.iterdir() if p.is_dir()):
        if a.task and task_dir.name != a.task:
            continue
        for cond_dir in sorted(p for p in task_dir.iterdir() if p.is_dir()):
            runs = cond_dir / "runs"
            if not runs.is_dir():
                continue
            for run_dir in sorted(runs.iterdir(), key=lambda p: (len(p.name), p.name)):
                if not (run_dir / "app").is_dir():
                    continue
                key = (task_dir.name, cond_dir.name, run_dir.name)
                r = probes.get(key)
                out_rows.append({
                    "task": key[0], "condition": key[1], "run_id": key[2],
                    "model": (r or {}).get("model", ""),
                    "probe_present": bool(r),
                    "run_status": (r or {}).get("run_status", ""),
                    "boot_ok": (r or {}).get("boot_ok", ""),
                })
                if not r:
                    missing.append(key)

    out_f = bdir / "completeness_report.csv"
    if out_rows:
        with out_f.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(out_rows[0].keys()))
            w.writeheader()
            w.writerows(out_rows)

    total = len(out_rows)
    present = sum(1 for r in out_rows if r["probe_present"])
    print(f"runs on disk: {total}   probe rows present: {present}   missing: {len(missing)}"
          + (f"   (task={a.task})" if a.task else ""))
    if missing:
        print("\nMISSING PROBE ROW (grade these with automatic_probes.py):")
        for t, c, n in missing:
            print(f"  {t}/{c}/runs/{n}")
    else:
        print("All runs on disk have an automatic-probe row.")
    print(f"\nwrote {out_f}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
