#!/usr/bin/env python3
"""
serve.py - start one sampled app by opaque id, revealing nothing about it.

Reads the sealed mapping itself, runs the app in place (nothing is copied),
and filters every line of its output so the run path and the condition name
never reach the terminal or the log. Ctrl-C stops it.

    python3 regrade/serve.py R037

Ports are whatever the app declares; they are not randomised, because these
apps hardcode their own ports and changing them would alter behaviour.
"""
import argparse, csv, json, os, re, signal, subprocess, sys, threading
from pathlib import Path

BATCH = Path("runs/batch-20260613")
CONDITIONS = ["no_verification", "static", "boot_check", "execution", "visual",
              "visual_no_shell", "delayed_verification", "behavioral"]
SCRIPT_ORDER = ["dev", "start", "dev:server", "dev:backend", "serve"]
URL = re.compile(r"https?://(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)\S*")


def load(rid):
    p = Path("regrade/_sealed/MAPPING.csv")
    if not p.exists():
        sys.exit("no regrade/_sealed/MAPPING.csv - run stage.py first")
    for r in csv.DictReader(p.open(encoding="utf-8")):
        if r["rid"] == rid:
            return r
    sys.exit(f"{rid} is not in the mapping")


def make_filter(app_dir, row):
    """Redact anything that would identify the run or its condition."""
    variants = set()
    for p in (app_dir, app_dir.parent, app_dir.parent.parent):
        s = str(p)
        variants |= {s, s.replace("\\", "/"), s.replace("/", "\\")}
        if len(s) > 2 and s[1] == ":":                    # D:\... and /d/...
            variants.add("/" + s[0].lower() + s[2:].replace("\\", "/"))
    pats = [re.escape(v) for v in sorted(variants, key=len, reverse=True)]
    pats += [r"\b" + re.escape(c) + r"\b" for c in CONDITIONS]
    pats.append(re.escape(row["task"]))
    rx = re.compile("|".join(pats), re.I)
    return lambda line: rx.sub("<redacted>", line)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rid")
    ap.add_argument("--script", help="npm script to run (default: first available)")
    ap.add_argument("--cmd", help="run this raw command in the app dir instead of an "
                                  "npm script, for a recorded launch accommodation "
                                  "(e.g. --cmd \"npx vite\"). Logged verbatim.")
    a = ap.parse_args()

    row = load(a.rid)
    app = BATCH / row["task"] / row["condition"] / "runs" / row["run_id"] / "app"
    if not app.is_dir():
        sys.exit(f"{a.rid}: app directory is missing")

    pkg_path = app / "package.json"
    scripts = {}
    if pkg_path.exists():
        scripts = (json.load(pkg_path.open(encoding="utf-8")) or {}).get("scripts", {})
    chosen = None if a.cmd else (a.script or next((s for s in SCRIPT_ORDER if s in scripts), None))
    if not chosen and not a.cmd:
        print(f"{a.rid}: no recognised start script. Declared: "
              f"{', '.join(scripts) or '(none)'}")
        print("Pick one with --script, or treat as a launch failure per the "
              "grading guide.")
        sys.exit(2)

    scrub = make_filter(app, row)
    outdir = Path("regrade") / a.rid
    outdir.mkdir(parents=True, exist_ok=True)
    log = (outdir / "serve.log").open("w", encoding="utf-8")

    label = a.cmd if a.cmd else f"npm run {chosen}"
    print(f"{a.rid} - starting ({label}); output is redacted, "
          f"full copy in {outdir/'serve.log'}")
    env = dict(os.environ, NO_COLOR="1", FORCE_COLOR="0", BROWSER="none")
    argv = a.cmd if a.cmd else ["npm", "run", chosen]
    proc = subprocess.Popen(argv, cwd=str(app), env=env, shell=bool(a.cmd) or (os.name == "nt"),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1)

    seen = set()

    def pump():
        for raw in proc.stdout:
            line = scrub(raw.rstrip("\n"))
            log.write(line + "\n"); log.flush()
            m = URL.search(line)
            if m and m.group(0) not in seen:
                seen.add(m.group(0))
                print(f"  {a.rid} ready at {m.group(0)}")
            print("  | " + line)

    t = threading.Thread(target=pump, daemon=True); t.start()
    print(f"  score into {outdir/'card.json'} - Ctrl-C when finished\n")
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        print(f"\n{a.rid} stopped.")
    finally:
        log.close()


if __name__ == "__main__":
    main()
