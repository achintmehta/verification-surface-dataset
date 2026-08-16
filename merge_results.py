#!/usr/bin/env python3
"""
merge_results.py - THE join and THE sole card-scorer. Combines the automatic
probe results, the human cards, and the config-defect scans into one
analysis-ready record per run, so paper numbers never need re-deriving from
scratch. This is the ONLY place a card is turned into a score.

Joins, per run (all under runs/<batch>/ unless noted). Content + provenance:
  automatic_probes_results.jsonl  machine grades, one row APPENDED per run by
                                  grader/automatic_probes.py (boot, functional,
                                  fidelity, probes, static defects, uptake,
                                  notes; schema: grader/RESULTS-SCHEMA.md)
  visual-scores.json              the per-run human card: blank card emitted by
                                  automatic_probes.py --emit-scorecards, filled
                                  by the human grader condition-blind in
                                  shuffled order. CURRENT state (human score,
                                  grader name) is scored HERE, once
  grader/rubrics/*.rubric.json    (repo root) rubric item weights, authored
                                  with the specs and frozen before grading
  frontend-launch-audit.csv       hand adjudication record (2026-07-15): every
                                  graded all-fail card behind a booted backend
                                  was swept mechanically and classified by the
                                  grader from the grading notes. Only rows with
                                  status LAUNCH-FAILED affect anything: they
                                  mark runs whose frontend is unrenderable by
                                  any declared path, overriding survival.
                                  RENDERS-BROKEN rows (app comes up, fails its
                                  criteria) and CARD-CORRECTED rows (grading
                                  fixes) are documentation only. Optional file:
                                  absent means no overrides.
  wiring_report.csv               written by scan_wiring.py, UNIFORM over all
                                  runs: static wiring coherence (statuses OK |
                                  NO_VITE | PROXY_NOT_LOADED | API_JS_COLLISION
                                  | PORT_MISMATCH | NO_PROXY_CONFIG) plus
                                  no-code and existing-script fixes
  datadir_report.csv              written by find_missing_datadir.py, UNIFORM:
                                  data-directory creation scan (OK-* | LATENT |
                                  WILL-FAIL | UNKNOWN; UNKNOWNs hand-resolved
                                  in datadir-unknown-resolutions.csv)
  grading-hazards.csv             (repo root) hand-compiled DISCOVERY record
                                  from the manual grading campaign: 52 runs
                                  where the grader observed hazard class
                                  A_proxy_swallows_api_js (detail = the vite
                                  config holding the offending proxy rule) or
                                  B_positional_root_skips_config (detail = the
                                  positional dev script line). Scope is those
                                  two classes only, coverage is non-uniform by
                                  nature (runs the grader launched and
                                  investigated); the UNIFORM measurement of
                                  these defect families is wiring_report.csv.
                                  Feeds only the launch_hazard_class annotation
                                  column. Frozen for batch-20260613; never
                                  updated. Optional file.

Outputs (next to the probe jsonl):
  run-summary.csv           the flat analysis table - UNCHANGED schema/values
                            (scalar columns; see below). Kept for tooling and as
                            a regression anchor.
  merged_results.jsonl      NEW master record, one JSON row per run: the full
                            probe row PLUS the human scalars, scan statuses, and
                            derived columns (a superset of run-summary.csv).
  visual_items.jsonl        companion, one row per run with a card:
                            {run, task, condition, run_id, model, grader_name,
                             items:{item_id: pass|partial|fail|skip}} - the
                            granular per-item human record (what results.jsonl's
                            visual_items used to hold), so the freeze stays
                            complete without sealing the cards.
  genuine-boot-failures.csv runs that STILL do not boot and whose card is still
                            machine-autofilled (auto:backend_boot_failed) or whose
                            static evidence shows a source-level defect
  ungraded-runs.csv         (a) runs on disk missing from the probe jsonl,
                            (b) runs whose card is blank/partial

run-summary.csv columns (scalar; unchanged): task, condition, run_id, model,
  in_results_jsonl, run_status, boot_ok, boot_failure_class, functional_pct,
  probes_passed, probes_total, fidelity_score, human_pct_current,
  human_items_scored, human_items_passed, grader_name, card_state,
  wiring_status, wiring_fix, wiring_script_fix, datadir_status,
  datadir_missing_parent, launch_hazard_class, grader_installed_dirs,
  dir_assumption_fixed, screenshot_calls, syntax_defects, undeclared_imports,
  runs_via_declared_path.

Survival (runs_via_declared_path, the analysis-grade column): the app AS A
WHOLE comes up via some declared path = (boot_ok OR the human graded it above
zero via a config-space accommodation) AND the run is not LAUNCH-FAILED in
frontend-launch-audit.csv. Definition amended 2026-07-15;
verify_post_merge_results.py re-derives it two independent ways.

Boot-failure classification logic (genuine vs needs-review):
  NOTE on 'auto:' grader names: in the sealed batch-20260613 dataset every
  card is hand-graded (zero 'auto:' cards remain; card_state is 'graded' for
  all 1116 runs). The 'auto:' branches below are NOT dead code: they guard
  the workflow for FUTURE runs, where autofill_nonbooting_scorecards.py
  machine-fills all-fail cards for non-booting runs pending human
  verification. Without this check an autofilled card would classify as
  'graded' and be misreported as human-confirmed.
  A run in the audit's LAUNCH-FAILED set whose backend booted is GENUINE
  ("frontend launch failure, hand-audited").
  A run with boot_ok=False is GENUINE if any of:
    - static_defects.syntax_errors is non-empty (source-level, install-independent)
    - card grader_name is still 'auto:backend_boot_failed' (the human verifier
      left the autofail in place after manual checking)
  It is NEEDS-REVIEW if:
    - its card was hand-graded (human found it runnable => the probe row is
      stale for this run and it should be re-graded mechanically), or
    - boot_failure_class is module_not_found with NO undeclared imports
      (declared-but-unprovisioned: suspect the installer, not the model)

Usage: python3 merge_results.py [--root /mnt/d/eval-coding-agent-runs]
                                [--batch batch-20260613]
"""
import argparse, csv, json
from pathlib import Path

VALID = {"pass": 1.0, "partial": 0.5, "fail": 0.0, "skip": None}


def read_json(p):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return None


def card_score(card, weights):
    """(human_pct, items_scored, items_passed) from the CURRENT card state."""
    if not card or not weights:
        return None, 0, 0
    items = card.get("items") or {}
    earned = mx = 0.0
    scored = passed = 0
    for iid, w in weights.items():
        sc = str((items.get(iid) or {}).get("score", "")).strip().lower()
        if sc not in VALID or sc == "" or VALID[sc] is None:
            continue
        earned += VALID[sc] * w
        mx += w
        scored += 1
        passed += (sc == "pass")
    return (round(100 * earned / mx, 1) if mx else None), scored, passed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="/mnt/d/eval-coding-agent-runs")
    ap.add_argument("--batch", default="batch-20260613")
    a = ap.parse_args()
    root = Path(a.root)
    bdir = root / "runs" / a.batch

    # rubric weights
    weights = {}
    for f in (root / "grader" / "rubrics").glob("*.rubric.json"):
        r = read_json(f)
        if r:
            weights[f.name.replace(".rubric.json", "")] = {
                it["id"]: it["weight"] for it in r.get("items", [])}

    # automatic-probe results, keyed by task/cond/run_id
    results, bad = {}, 0
    probes_f = bdir / "automatic_probes_results.jsonl"
    if probes_f.exists():
        for line in probes_f.open(encoding="utf-8", errors="replace"):
            try:
                r = json.loads(line)
            except Exception:
                bad += 1
                continue
            parts = r.get("run", "").replace("\\", "/").rstrip("/").split("/")
            if len(parts) >= 4 and parts[-2] == "runs":
                results[(parts[-4], parts[-3], parts[-1])] = r

    # auxiliary scans (optional files)
    def load_csv_map(path, key_field, app_key=True):
        out = {}
        p = Path(path)
        if not p.exists():
            return out
        for row in csv.DictReader(p.open(encoding="utf-8", errors="replace")):
            k = row.get(key_field, "")
            if app_key:   # '<task>/<cond>/runs/<n>/app' -> (task, cond, n)
                seg = k.replace("\\", "/").split("/")
                if len(seg) >= 4:
                    out[(seg[0], seg[1], seg[3])] = row
            else:
                out[k] = row
        return out

    wiring = load_csv_map(bdir / "wiring_report.csv", "app")
    datadir = load_csv_map(bdir / "datadir_report.csv", "app")

    # hand-audited frontend launch failures: the backend boots (boot_ok=True)
    # but the frontend cannot come up through ANY declared path (e.g. a
    # parse-broken main.js), so the application as a whole never launches.
    # These override the survival column. Source of record:
    # frontend-launch-audit.csv (status LAUNCH-FAILED only; RENDERS-BROKEN
    # rows document apps that DO come up but fail their criteria, and
    # CARD-CORRECTED rows document grading fixes - neither affects survival).
    launch_dead = set()
    fla = bdir / "frontend-launch-audit.csv"
    if fla.exists():
        for row_ in csv.DictReader(fla.open(encoding="utf-8", errors="replace")):
            if (row_.get("status") or "").strip().upper() == "LAUNCH-FAILED":
                seg = (row_.get("app") or "").replace("\\", "/").split("/")
                if len(seg) >= 4:
                    launch_dead.add((seg[0], seg[1], seg[3]))
    hazards = {}
    hz = root / "grading-hazards.csv"
    if hz.exists():
        for row in csv.DictReader(hz.open(encoding="utf-8", errors="replace")):
            seg = row["run"].replace("\\", "/").split("/")
            if len(seg) >= 4:
                hazards[(seg[-4], seg[-3], seg[-1])] = row["hazard_class"]

    rows, genuine, review, ungraded = [], [], [], []
    merged, vis_items = [], []            # merged_results.jsonl + visual_items.jsonl
    for task_dir in sorted(p for p in bdir.iterdir() if p.is_dir()):
        for cond_dir in sorted(p for p in task_dir.iterdir() if p.is_dir()):
            runs = cond_dir / "runs"
            if not runs.is_dir():
                continue
            for run_dir in sorted(runs.iterdir(), key=lambda p: (len(p.name), p.name)):
                if not (run_dir / "app").is_dir():
                    continue
                key = (task_dir.name, cond_dir.name, run_dir.name)
                res = results.get(key)
                card = read_json(run_dir / "smoke" / "logs" / "visual-scores.json")
                gname = (card or {}).get("grader_name", "") or ""
                hpct, hscored, hpassed = card_score(card, weights.get(task_dir.name))
                w = wiring.get(key, {})
                d = datadir.get(key, {})
                notes = (res or {}).get("notes", [])
                up = (res or {}).get("tool_uptake") or {}
                probes = (res or {}).get("probes") or {}
                n_probe_pass = sum(1 for p in probes.values() if p.get("ok"))

                row = {
                    "task": key[0], "condition": key[1], "run_id": key[2],
                    "model": (res or {}).get("model", ""),
                    "in_results_jsonl": bool(res),
                    "run_status": (res or {}).get("run_status", ""),
                    "boot_ok": (res or {}).get("boot_ok", ""),
                    "boot_failure_class": (res or {}).get("boot_failure_class", ""),
                    "functional_pct": (res or {}).get("functional_pct", ""),
                    "probes_passed": n_probe_pass if probes else "",
                    "probes_total": len(probes) if probes else "",
                    "fidelity_score": (res or {}).get("fidelity_score", ""),
                    "human_pct_current": hpct if hpct is not None else "",
                    "human_items_scored": hscored,
                    "human_items_passed": hpassed,
                    "grader_name": gname,
                    "card_state": ("autofail" if gname.startswith("auto:")
                                   else "graded" if hscored else
                                   "blank" if card else "no_card"),
                    "wiring_status": w.get("status", ""),
                    "wiring_fix": w.get("no_code_fix", ""),
                    "wiring_script_fix": w.get("existing_script_fix", ""),
                    "datadir_status": d.get("status", ""),
                    "datadir_missing_parent": d.get("missing_parent", ""),
                    "launch_hazard_class": hazards.get(key, ""),
                    "grader_installed_dirs": ";".join(
                        n.split(":", 1)[1] for n in notes if n.startswith("npm_install_dir:")),
                    "dir_assumption_fixed": any(n.startswith("dir_assumption_fixed") for n in notes),
                    "screenshot_calls": up.get("screenshot", ""),
                    "syntax_defects": len(((res or {}).get("static_defects") or {}).get("syntax_errors", [])),
                    "undeclared_imports": len(((res or {}).get("static_defects") or {}).get("undeclared_imports", [])),
                }
                # Derived truth column: does the APP AS A WHOLE come up via ANY
                # declared path? boot_ok is the grader's direct-node view of the
                # BACKEND only; a hand-graded card with a nonzero score means the
                # human launched it under a config-space accommodation (PORT=,
                # build+start, bare vite); and the frontend-launch audit records
                # runs whose backend boots but whose frontend is unrenderable by
                # any declared path (those do NOT survive). Use THIS column for
                # boot-survival analyses; keep boot_ok for instrument comparisons.
                row["runs_via_declared_path"] = (
                    (row["boot_ok"] is True
                     or (row["card_state"] == "graded" and (hpct or 0) > 0))
                    and key not in launch_dead)
                rows.append(row)

                # merged_results.jsonl: full probe row + the joined summary fields
                merged.append({**(res or {}), **row})
                # visual_items.jsonl companion: the per-item human map (faithful to
                # the old results.jsonl visual_items: skip kept, blank/invalid dropped)
                wmap_run = weights.get(task_dir.name)
                if card is not None and wmap_run:
                    items_map = {}
                    for iid, wt in wmap_run.items():
                        scv = str(((card.get("items") or {}).get(iid) or {}).get("score", "")).strip().lower()
                        if scv == "" or scv not in VALID:
                            continue
                        items_map[iid] = "skip" if VALID[scv] is None else scv
                    vis_items.append({
                        "run": (res or {}).get("run", ""),
                        "task": key[0], "condition": key[1], "run_id": key[2],
                        "model": row["model"], "grader_name": gname,
                        "items": items_map,
                    })

                # --- classification side-files ---
                if not res:
                    ungraded.append({**{k2: row[k2] for k2 in
                                        ("task", "condition", "run_id")},
                                     "reason": "no probe row (new run, never machine-graded)"})
                elif row["card_state"] in ("blank", "no_card") and hpct is None:
                    ungraded.append({**{k2: row[k2] for k2 in
                                        ("task", "condition", "run_id")},
                                     "reason": f"card {row['card_state']}"})
                if key in launch_dead and (res or {}).get("boot_ok") is not False:
                    genuine.append(dict(
                        task=key[0], condition=key[1], run_id=key[2],
                        model=row["model"],
                        boot_failure_class="frontend_launch",
                        syntax_defects=row["syntax_defects"],
                        undeclared_imports=row["undeclared_imports"],
                        card_state=row["card_state"], grader_name=gname,
                        verdict=("genuine: frontend launch failure (backend boots, "
                                 "frontend unrenderable by any declared path; "
                                 "hand-audited in frontend-launch-audit.csv)")))
                if res and res.get("boot_ok") is False:
                    ev = dict(task=key[0], condition=key[1], run_id=key[2],
                              model=row["model"],
                              boot_failure_class=row["boot_failure_class"],
                              syntax_defects=row["syntax_defects"],
                              undeclared_imports=row["undeclared_imports"],
                              card_state=row["card_state"], grader_name=gname)
                    if row["syntax_defects"] > 0 or gname.startswith("auto:"):
                        ev["verdict"] = ("genuine: source syntax defect"
                                         if row["syntax_defects"] > 0 else
                                         "genuine: human left autofail in place")
                        genuine.append(ev)
                    elif hscored and (hpct or 0) == 0:
                        ev["verdict"] = "genuine: hand-graded all-fail (human confirmed non-functional)"
                        genuine.append(ev)
                    elif hscored:
                        ev["verdict"] = ("conflict: grader cannot boot it but human graded it "
                                         f"{hpct}% via a config-space accommodation; "
                                         "human grade stands, use runs_via_declared_path")
                        review.append(ev)
                    else:
                        ev["verdict"] = ("review: module_not_found with all imports declared "
                                         "=> suspect installer" if
                                         (row["boot_failure_class"] == "module_not_found"
                                          and row["undeclared_imports"] == 0)
                                         else "review: unclassified")
                        review.append(ev)

    def dump(name, data):
        p = bdir / name
        if data:
            with p.open("w", newline="", encoding="utf-8") as f:
                wtr = csv.DictWriter(f, fieldnames=list(data[0].keys()))
                wtr.writeheader()
                wtr.writerows(data)
        else:
            # an empty table must also remove any stale file from a previous
            # run, or an old ungraded-runs.csv can linger and mislead
            p.unlink(missing_ok=True)
        return p

    def dump_jsonl(name, data):
        p = bdir / name
        with p.open("w", encoding="utf-8") as f:
            for d in data:
                f.write(json.dumps(d) + "\n")
        return p

    p1 = dump("run-summary.csv", rows)
    p2 = dump("genuine-boot-failures.csv", genuine + review)
    p3 = dump("ungraded-runs.csv", ungraded)
    p4 = dump_jsonl("merged_results.jsonl", merged)
    p5 = dump_jsonl("visual_items.jsonl", vis_items)

    print(f"runs on disk: {len(rows)}   with probe row: {sum(1 for r in rows if r['in_results_jsonl'])}"
          f"   (unparseable probe lines: {bad})")
    print(f"boot failures: genuine={len(genuine)}  needs-review={len(review)}")
    print(f"ungraded: {len(ungraded)}")
    from collections import Counter
    print("card states:", dict(Counter(r["card_state"] for r in rows)))
    print("wiring issues:", dict(Counter(r["wiring_status"] for r in rows
                                          if r["wiring_status"] not in ("", "OK", "NO_VITE"))))
    print("datadir at-risk:", dict(Counter(r["datadir_status"] for r in rows
                                            if r["datadir_status"] in ("WILL-FAIL", "LATENT"))))
    print(f"\nwrote {p1}\n      {p2}\n      {p3}\n      {p4}\n      {p5}")


if __name__ == "__main__":
    main()
