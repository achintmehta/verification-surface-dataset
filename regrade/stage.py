#!/usr/bin/env python3
"""
stage.py - build the blind grading workspace. Copies nothing: the apps stay
where they are and serve.py opens them by opaque id.

Creates regrade/R001..Rnnn/, each holding a BLANK copy of that run's rubric
card, plus regrade/order.txt (the shuffled grading order) and the sealed
regrade/_sealed/MAPPING.csv.

Run --inspect first. It reports the card schema it detected and blanks one card
to stdout without writing anything, so you can confirm the blanking is right
before generating 112 of them.

    python3 regrade/stage.py --inspect
    python3 regrade/stage.py --seed 20260812
"""
import argparse, csv, json, random, shutil, sys
from pathlib import Path

BATCH = Path("runs/batch-20260613")
SCORE_KEYS = {"score", "value", "result", "verdict", "rating", "mark", "grade"}
NOTE_KEYS = {"note", "notes", "comment", "comments", "evidence"}


def card_path(task, cond, rid):
    return BATCH / task / cond / "runs" / rid / "smoke" / "logs" / "visual-scores.json"


def blank(obj):
    """Return a copy with every score/note emptied and everything else kept."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            kl = k.lower()
            if kl in SCORE_KEYS:
                out[k] = None
            elif kl in NOTE_KEYS:
                out[k] = ""
            elif kl in ("graded_by", "grader", "grader_name", "graded_at", "date"):
                out[k] = None
            else:
                out[k] = blank(v)
        return out
    if isinstance(obj, list):
        return [blank(v) for v in obj]
    return obj


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int)
    ap.add_argument("--sample", default="regrade/_sealed/sample.csv")
    ap.add_argument("--inspect", action="store_true")
    a = ap.parse_args()

    rows = list(csv.DictReader(open(a.sample, encoding="utf-8")))
    if not rows:
        sys.exit(f"no rows in {a.sample} - run draw_sample.py first")

    if a.inspect:
        r = rows[0]
        p = card_path(r["task"], r["condition"], r["run_id"])
        if not p.exists():
            sys.exit(f"no card at {p}")
        orig = json.load(p.open(encoding="utf-8"))
        print(f"sample card: {p}\n\n--- original (first 600 chars) ---")
        print(json.dumps(orig, indent=2)[:600])
        print("\n--- blanked (first 600 chars) ---")
        print(json.dumps(blank(orig), indent=2)[:600])
        print("\nIf scores are not None above, add their key name to SCORE_KEYS "
              "in this script and re-inspect. Nothing was written.")
        return

    if a.seed is None:
        sys.exit("--seed is required (record it in REGRADE_RUNBOOK.md)")

    missing = [r for r in rows
               if not card_path(r["task"], r["condition"], r["run_id"]).exists()]
    if missing:
        for r in missing:
            print(f"  MISSING CARD {r['task']}/{r['condition']}/{r['run_id']}")
        sys.exit(f"{len(missing)} sampled runs have no card; resolve before staging")

    no_mods = [r for r in rows
               if not (BATCH / r["task"] / r["condition"] / "runs" / r["run_id"]
                       / "app" / "node_modules").is_dir()]
    if no_mods:
        print(f"WARNING: {len(no_mods)} sampled runs have no node_modules. Do NOT "
              "reinstall (see REGRADE_RUNBOOK.md) - drop and replace them:")
        for r in no_mods:
            print(f"  {r['task']}/{r['condition']}/{r['run_id']}")

    order = list(rows)
    random.Random(a.seed).shuffle(order)

    root = Path("regrade")
    sealed = root / "_sealed"
    sealed.mkdir(parents=True, exist_ok=True)

    ids = []
    with (sealed / "MAPPING.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["rid", "task", "condition", "run_id"])
        for i, r in enumerate(order, 1):
            rid = f"R{i:03d}"
            ids.append(rid)
            w.writerow([rid, r["task"], r["condition"], r["run_id"]])
            d = root / rid
            d.mkdir(exist_ok=True)
            src = card_path(r["task"], r["condition"], r["run_id"])
            json.dump(blank(json.load(src.open(encoding="utf-8"))),
                      (d / "card.json").open("w", encoding="utf-8"), indent=2)

    (root / "order.txt").write_text("\n".join(ids) + "\n", encoding="utf-8")
    (root / "SESSIONS.txt").touch()
    print(f"staged {len(ids)} runs -> regrade/R001..{ids[-1] if ids else '-'}")
    print(f"order  -> regrade/order.txt (shuffle seed {a.seed})")
    print(f"sealed -> {sealed}/MAPPING.csv  DO NOT OPEN until grading is done")


if __name__ == "__main__":
    main()
