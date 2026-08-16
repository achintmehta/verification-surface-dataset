#!/usr/bin/env python3
"""
polish_compare.py - the visual polish comparison (paper section 7.3).

Pairwise, same-task, blinded side-by-side judgments over the uniform
screenshots; Bradley-Terry ranking; two comparison families:
  A) same model, different core conditions  (does tooling change polish?)
  B) same condition, different models       (is polish a model property?)

Three modes:
  python3 polish_compare.py --make-pairs         # writes polish-pairs.csv
  python3 polish_compare.py --serve              # local judging UI at :8099
  python3 polish_compare.py --analyze            # Bradley-Terry + report

Judging UI: left/right images, anonymized and side-randomized. Keys:
  1 = left is more polished, 2 = right, 0 = tie/can't say, s = skip (broken)
Judgments append to polish-judgments.csv (resumable). A second judge sets
--judge <name>; agreement (Cohen's kappa) is reported when two judges overlap.

Rules baked in: only non-blank captures with human score > 0 are paired;
metrics-dashboard pairs are same-theme only (dark/light there is grader
residue, not model choice); fixed seed for a reproducible schedule.
"""
import argparse, csv, json, random, statistics as st
from collections import Counter, defaultdict
from pathlib import Path

SEED = 20260703
CORE = ["no_verification", "static", "boot_check", "execution", "visual"]
TASKS = ["calendar-week-view", "metrics-dashboard"]   # the two visual venues


def load_shots(root, batch):
    rep = root / "runs" / batch / "screenshot-report.csv"
    rows = list(csv.DictReader(rep.open(encoding="utf-8")))
    ok = {}
    for r in rows:
        try:
            human = float(r["human"])
        except Exception:
            continue
        if r["blank"] == "True" or human <= 0 or r["condition"] not in CORE:
            continue
        if r["task"] not in TASKS:
            continue
        key = (r["task"], r["condition"], r["model"])
        # keep the best replicate per cell (same rule as the galleries)
        if key not in ok or human > ok[key][1]:
            p = (root / "runs" / batch / r["task"] / r["condition"] / "runs" /
                 r["run_id"] / "app" / "images" / "screenshot.png")
            ok[key] = (str(p), human, r["dark_mode"] == "True")
    return ok


def make_pairs(root, batch):
    shots = load_shots(root, batch)
    rng = random.Random(SEED)
    pairs = []
    def add(a, b, family):
        if a in shots and b in shots:
            # same-theme rule for the dashboard
            if a[0] == "metrics-dashboard" and shots[a][2] != shots[b][2]:
                return
            pairs.append(dict(family=family,
                              a_task=a[0], a_cond=a[1], a_model=a[2],
                              b_task=b[0], b_cond=b[1], b_model=b[2],
                              a_path=shots[a][0], b_path=shots[b][0]))
    models = sorted({k[2] for k in shots})
    for t in TASKS:
        for m in models:                              # family A: conditions within model
            for i in range(len(CORE)):
                for j in range(i + 1, len(CORE)):
                    add((t, CORE[i], m), (t, CORE[j], m), "A_condition_within_model")
        for c in CORE:                                # family B: models within condition
            for i in range(len(models)):
                for j in range(i + 1, len(models)):
                    add((t, c, models[i]), (t, c, models[j]), "B_model_within_condition")
    rng.shuffle(pairs)
    out = root / "runs" / batch / "polish-pairs.csv"
    with out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(pairs[0].keys()))
        w.writeheader()
        w.writerows(pairs)
    print(f"{len(pairs)} pairs -> {out}")
    print("families:", Counter(p["family"] for p in pairs))


def serve(root, batch, judge, port):
    import http.server, urllib.parse
    pairs_f = root / "runs" / batch / "polish-pairs.csv"
    jd_f = root / "runs" / batch / "polish-judgments.csv"
    pairs = list(csv.DictReader(pairs_f.open(encoding="utf-8")))
    done = set()
    if jd_f.exists():
        for r in csv.DictReader(jd_f.open(encoding="utf-8")):
            if r["judge"] == judge:
                done.add(int(r["pair_idx"]))
    rng = random.Random(SEED + hash(judge) % 1000)
    flips = [rng.random() < 0.5 for _ in pairs]       # per-pair side randomization

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            q = urllib.parse.urlparse(self.path)
            if q.path == "/img":
                p = urllib.parse.parse_qs(q.query)["p"][0]
                try:
                    data = open(p, "rb").read()
                    self.send_response(200); self.send_header("Content-Type", "image/png")
                    self.end_headers(); self.wfile.write(data)
                except Exception:
                    self.send_response(404); self.end_headers()
                return
            if q.path == "/vote":
                qs = urllib.parse.parse_qs(q.query)
                i, v = int(qs["i"][0]), qs["v"][0]
                pr, flip = pairs[i], flips[i]
                # translate left/right vote back to a/b
                winner = {"left": "b" if flip else "a", "right": "a" if flip else "b",
                          "tie": "tie", "skip": "skip"}[v]
                new = not jd_f.exists()
                with jd_f.open("a", newline="") as f:
                    w = csv.writer(f)
                    if new:
                        w.writerow(["pair_idx", "judge", "family", "a_task", "a_cond",
                                    "a_model", "b_cond", "b_model", "winner"])
                    w.writerow([i, judge, pr["family"], pr["a_task"], pr["a_cond"],
                                pr["a_model"], pr["b_cond"], pr["b_model"], winner])
                done.add(i)
            # next undone pair
            nxt = next((k for k in range(len(pairs)) if k not in done), None)
            if nxt is None:
                body = "<h2>All pairs judged. Run --analyze.</h2>"
            else:
                pr, flip = pairs[nxt], flips[nxt]
                l, r = (pr["b_path"], pr["a_path"]) if flip else (pr["a_path"], pr["b_path"])
                lq, rq = urllib.parse.quote(l), urllib.parse.quote(r)
                body = f"""
<div style="font-family:sans-serif">
 <p>{len(done)}/{len(pairs)} judged &middot; task: {pr['a_task']} &middot;
    which looks more <b>polished</b>? (1=left 2=right 0=tie s=skip)</p>
 <div style="display:flex;gap:8px">
  <img src="/img?p={lq}" style="width:49%;border:1px solid #999">
  <img src="/img?p={rq}" style="width:49%;border:1px solid #999">
 </div>
 <p><a href="/vote?i={nxt}&v=left">LEFT (1)</a> &middot;
    <a href="/vote?i={nxt}&v=right">RIGHT (2)</a> &middot;
    <a href="/vote?i={nxt}&v=tie">TIE (0)</a> &middot;
    <a href="/vote?i={nxt}&v=skip">SKIP (s)</a></p>
 <script>document.onkeydown=e=>{{const m={{'1':'left','2':'right','0':'tie','s':'skip'}};
   if(m[e.key])location='/vote?i={nxt}&v='+m[e.key];}};</script>
</div>"""
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body.encode())
    print(f"judging as '{judge}' at http://localhost:{port}  (Ctrl+C to stop; resumable)")
    http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()


def bradley_terry(items, wins):
    """wins[(i,j)] = times i beat j. Returns strength per item (MM algorithm)."""
    s = {i: 1.0 for i in items}
    for _ in range(200):
        new = {}
        for i in items:
            num = sum(wins.get((i, j), 0) for j in items if j != i)
            den = sum((wins.get((i, j), 0) + wins.get((j, i), 0)) / (s[i] + s[j])
                      for j in items if j != i)
            new[i] = (num / den) if den else s[i]
        norm = sum(new.values()) / len(new)
        s = {k: v / norm for k, v in new.items()}
    return s


def analyze(root, batch):
    jd_f = root / "runs" / batch / "polish-judgments.csv"
    rows = list(csv.DictReader(jd_f.open(encoding="utf-8")))
    rows = [r for r in rows if r["winner"] in ("a", "b", "tie")]
    print(f"{len(rows)} judgments ({Counter(r['judge'] for r in rows)})\n")

    for fam, key_a, key_b, label in [
            ("A_condition_within_model", "a_cond", "b_cond", "POLISH BY CONDITION (within model)"),
            ("B_model_within_condition", "a_model", "b_model", "POLISH BY MODEL (within condition)")]:
        sub = [r for r in rows if r["family"] == fam]
        wins = Counter()
        items = set()
        for r in sub:
            a, b = r[key_a], r[key_b]
            items |= {a, b}
            if r["winner"] == "a":
                wins[(a, b)] += 1
            elif r["winner"] == "b":
                wins[(b, a)] += 1
            else:
                wins[(a, b)] += 0.5; wins[(b, a)] += 0.5
        if not items:
            continue
        s = bradley_terry(sorted(items), wins)
        print(f"== {label} ==  (Bradley-Terry strength, 1.0 = average)")
        for k, v in sorted(s.items(), key=lambda x: -x[1]):
            print(f"  {k:22s} {v:5.2f}")
        print()

    # inter-judge agreement on overlapping pairs
    byjudge = defaultdict(dict)
    for r in rows:
        byjudge[r["judge"]][r["pair_idx"]] = r["winner"]
    judges = list(byjudge)
    if len(judges) >= 2:
        j1, j2 = judges[:2]
        common = set(byjudge[j1]) & set(byjudge[j2])
        if common:
            agree = sum(byjudge[j1][i] == byjudge[j2][i] for i in common)
            po = agree / len(common)
            # Cohen's kappa with 3 categories
            c1, c2 = Counter(byjudge[j1][i] for i in common), Counter(byjudge[j2][i] for i in common)
            pe = sum((c1[c] / len(common)) * (c2[c] / len(common)) for c in ("a", "b", "tie"))
            kappa = (po - pe) / (1 - pe) if pe < 1 else 1.0
            print(f"inter-judge agreement ({j1} vs {j2}): {po:.0%} raw, kappa = {kappa:.2f} "
                  f"on {len(common)} shared pairs")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="/mnt/d/eval-coding-agent-runs")
    ap.add_argument("--batch", default="batch-20260613")
    ap.add_argument("--make-pairs", action="store_true")
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--judge", default="achint")
    ap.add_argument("--port", type=int, default=8099)
    a = ap.parse_args()
    root = Path(a.root)
    if a.make_pairs:
        make_pairs(root, a.batch)
    elif a.serve:
        serve(root, a.batch, a.judge, a.port)
    elif a.analyze:
        analyze(root, a.batch)
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
