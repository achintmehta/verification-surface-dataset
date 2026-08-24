#!/usr/bin/env python3
"""Cross-check every number quoted in the paper's text against this repository.

Companion to CLAIMS.md. Recomputes, from the committed inputs, each claim that
is not printed verbatim in freeze-20260720/freeze-tables.txt or
paper/stats-results.txt, and re-parses those two files for the values that are.
Standard library only. Run from the repository root:

    python3 verify_paper_claims.py        # healthy output ends: 0 discrepancies

`--skip-run-tree` skips the sections that scan the per-run manifest.json /
commands.json files, checking only the batch-level tables and committed
outputs. `--with-traces` additionally scans the 264 sight-condition
trace.jsonl files to re-derive the screenshot-channel counts; those files
carry embedded images and total several hundred megabytes, so that pass is
opt-in and can take several minutes.

Data sources: freeze-20260720/ (dataset of record), runs/batch-20260613/
batch tables, grading-hazards.csv, agent-interface/, specs/, and the per-run
manifest.json / commands.json files.
"""
import csv, glob, hashlib, json, math, re, sys
from collections import Counter, defaultdict

if hasattr(sys.stdout, "reconfigure"):           # byte-identical output on every
    sys.stdout.reconfigure(encoding="utf-8")     # platform (Windows included)

SKIP_TREE = "--skip-run-tree" in sys.argv
WITH_TRACES = "--with-traces" in sys.argv
FZ = "freeze-20260720"
BATCH = "runs/batch-20260613"
checks = []


def check(name, ok, detail=""):
    checks.append((name, bool(ok), detail))
    print(f"  [{'ok' if ok else 'FAIL'}] {name}" + (f"  ({detail})" if detail and not ok else ""))


def load_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def norm(model):
    return model.replace("-anthropic", "")


print("== census and survival (run-summary.csv) ==")
rs = load_csv(f"{FZ}/run-summary.csv")
for r in rs:
    r["model"] = norm(r["model"])
check("1,116 runs", len(rs) == 1116, str(len(rs)))
check("186 runs per model", set(Counter(r["model"] for r in rs).values()) == {186})
fails = [r for r in rs if r["runs_via_declared_path"] != "True"]
check("66 genuine launch failures", len(fails) == 66, str(len(fails)))
fc = Counter(r["condition"] for r in fails)
check("failures by condition 26/30/1/2/1 (core five)",
      [fc[c] for c in ("no_verification", "static", "boot_check", "execution", "visual")] == [26, 30, 1, 2, 1])
check("56 failures in no_verification+static", fc["no_verification"] + fc["static"] == 56)
lf = [r for r in fails if r["task"] == "log-explorer-perf"]
check("13 of 66 on the log explorer", len(lf) == 13, str(len(lf)))
check("11 of those 13 in the two blind conditions",
      sum(1 for r in lf if r["condition"] in ("no_verification", "static")) == 11)
check("boot_check 191 of 192 boot",
      sum(1 for r in rs if r["condition"] == "boot_check" and r["runs_via_declared_path"] == "True") == 191)
check("behavioral: 24 runs, 4 failures (83%)",
      sum(1 for r in rs if r["condition"] == "behavioral") == 24 and fc["behavioral"] == 4)


def mean(vals):
    return round(sum(vals) / len(vals), 1)


def scores(cond, tasks, col):
    return [float(r[col]) for r in rs if r["condition"] == cond and r["task"] in tasks and r[col] != ""]


print("== score ladders (recomputed from run-summary.csv) ==")
API = ("message-board", "kanban-board", "seat-booking")
got = [mean(scores(c, API, "functional_pct")) for c in
       ("no_verification", "static", "boot_check", "execution", "visual")]
check("functional pooled 81.9/78.3/91.7/94.2/92.6", got == [81.9, 78.3, 91.7, 94.2, 92.6], str(got))
check("behavioral 71.2 vs execution 87.3 (seat-booking)",
      mean(scores("behavioral", ("seat-booking",), "functional_pct")) == 71.2
      and mean(scores("execution", ("seat-booking",), "functional_pct")) == 87.3)
VIS = ("calendar-week-view", "metrics-dashboard")
got = [mean(scores(c, VIS, "human_pct_current")) for c in
       ("no_verification", "static", "boot_check", "execution", "visual")]
check("human two-visual-tasks 72.8/72.6/89.5/89.2/96.1", got == [72.8, 72.6, 89.5, 89.2, 96.1], str(got))
conds6 = ("no_verification", "static", "boot_check", "execution", "visual", "visual_no_shell")
cal = [mean(scores(c, ("calendar-week-view",), "human_pct_current")) for c in conds6]
dash = [mean(scores(c, ("metrics-dashboard",), "human_pct_current")) for c in conds6]
log = [mean(scores(c, ("log-explorer-perf",), "human_pct_current")) for c in conds6]
check("Table VI calendar row", cal == [81.4, 84.8, 96.6, 86.4, 97.3, 90.7], str(cal))
check("Table VI dashboard row", dash == [64.3, 60.4, 82.5, 92.0, 94.9, 97.7], str(dash))
check("log-explorer human ladder", log == [78.5, 80.5, 84.8, 93.8, 91.7, 91.2], str(log))
check("sight gaps +10.9 / +2.9 / -2.1",
      (round(cal[4] - cal[3], 1), round(dash[4] - dash[3], 1), round(log[4] - log[3], 1)) == (10.9, 2.9, -2.1))
BF, KB = ("kanban-labels-brownfield",), ("kanban-board",)
check("brownfield gaps 10.0 (functional) / 14.0 (human)",
      round(mean(scores("execution", BF, "functional_pct")) - mean(scores("no_verification", BF, "functional_pct")), 1) == 10.0
      and round(mean(scores("execution", BF, "human_pct_current")) - mean(scores("no_verification", BF, "human_pct_current")), 1) == 14.0)
check("greenfield gaps 10.6 / 11.8",
      round(mean(scores("execution", KB, "functional_pct")) - mean(scores("no_verification", KB, "functional_pct")), 1) == 10.6
      and round(mean(scores("execution", KB, "human_pct_current")) - mean(scores("no_verification", KB, "human_pct_current")), 1) == 11.8)

print("== failure anatomy (audit files) ==")
gbf = load_csv(f"{FZ}/genuine-boot-failures.csv")
check("35 backend corrupted-source verdicts",
      sum(1 for r in gbf if r["verdict"].startswith("genuine: source syntax defect")) == 35)
fla = load_csv(f"{FZ}/frontend-launch-audit.csv")
lfrows = [r for r in fla if "LAUNCH-FAILED" in str(r)]
check("10 frontend launch failures; 5 from static",
      len(lfrows) == 10 and sum(1 for r in lfrows if "static" in str(r)) == 5)
gh = load_csv("grading-hazards.csv")
hz = Counter(r["hazard_class"] for r in gh)
check("52 launch-hazard runs = 20 class A + 32 class B",
      len(gh) == 52 and hz["A_proxy_swallows_api_js"] == 20 and hz["B_positional_root_skips_config"] == 32)

print("== configuration defects ==")
WIRE_BAD = {"PROXY_NOT_LOADED", "API_JS_COLLISION", "PORT_MISMATCH", "NO_PROXY_CONFIG", "NO_PROXY_IN_CONFIG"}
check("45 wiring defects (4%)", sum(1 for r in rs if r["wiring_status"] in WIRE_BAD) == 45)
dd = [r for r in rs if r["datadir_status"] in ("WILL-FAIL", "LATENT")]
ddu = load_csv(f"{FZ}/datadir-unknown-resolutions.csv")
confirmed = sum(1 for r in ddu if r["resolved_status"] == "CONFIRMED-BUG")
check("datadir bug 169 total (167 scanner + 2 confirmed by hand)",
      len(dd) == 167 and confirmed == 2)
dm, mn = Counter(r["model"] for r in dd), Counter(r["model"] for r in rs)
trunc = {m: 100 * dm[m] // mn[m] for m in mn}
check("datadir per model 41/24/3, grok exactly one build",
      trunc["claude-4.6-sonnet"] == 41 and trunc["claude-4.8-opus"] == 24
      and trunc["gemini-3.1-pro"] == 3 and dm["grok-4.3"] == 1)

print("== brownfield companion (extend-vs-rewrite.csv) ==")
evr = load_csv(f"{BATCH}/extend-vs-rewrite.csv")
rw = [r for r in evr if r["verdict"] == "REWROTE"]
touched = sorted(int(r["modified"]) + int(r["deleted"]) for r in evr)
check("140 of 144 extended; median 3 files touched; rewrites 3 static + 1 visual",
      len(evr) == 144 and len(rw) == 4 and touched[len(touched) // 2] == 3
      and Counter(r["condition"] for r in rw) == Counter({"static": 3, "visual": 1}))

print("== architecture signatures (architecture-report.csv) ==")
arch = load_csv(f"{BATCH}/architecture-report.csv")
for r in arch:
    r["model"] = norm(r["model"])


def cramers_v(feat, group):
    tbl = defaultdict(Counter)
    for r in arch:
        tbl[r[group]][r[feat]] += 1
    groups = list(tbl)
    cats = sorted({c for g in groups for c in tbl[g]})
    n = sum(sum(c.values()) for c in tbl.values())
    col = {c: sum(tbl[g][c] for g in groups) for c in cats}
    chi = sum((tbl[g][c] - sum(tbl[g].values()) * col[c] / n) ** 2 / (sum(tbl[g].values()) * col[c] / n)
              for g in groups for c in cats if col[c])
    return round(math.sqrt(chi / (n * (min(len(groups), len(cats)) - 1))), 2)


TABLE7 = [("manifest_layout", .46, .16), ("dir_style", .40, .10), ("module_system", .36, .10),
          ("dev_orchestration", .39, .13), ("vite_invocation", .27, .12), ("api_client_style", .34, .12),
          ("has_readme", .70, .18), ("has_tests", .17, .66)]
ok7 = all(abs(cramers_v(f, "model") - vm) <= .011 and abs(cramers_v(f, "condition") - vc) <= .011
          for f, vm, vc in TABLE7)
check("Table IX Cramér's V (eight quoted pairs)", ok7)
check("TypeScript / standard-build-tool associations weak",
      all(cramers_v(f, g) < .25 for f in ("uses_typescript", "uses_vite") for g in ("model", "condition")))
per = {m: [r for r in arch if r["model"] == m] for m in mn}
gpt, grok = per["gpt-5.5"], per["grok-4.3"]
check("gpt-5.5 launches bare in 94% of runs (src tree 77%)",
      round(100 * sum(1 for r in gpt if r["vite_invocation"] == "bare") / len(gpt)) == 94
      and round(100 * sum(1 for r in gpt if r["dir_style"] == "src-tree") / len(gpt)) == 77)
check("grok-4.3 mixes manifest layouts in 82% of runs",
      round(100 * sum(1 for r in grok if r["manifest_layout"] == "mixed") / len(grok)) == 82)
CORE = ("no_verification", "static", "boot_check", "execution", "visual")
locs = [sum(int(r["total_loc"]) for r in arch if r["condition"] == c)
        / sum(1 for r in arch if r["condition"] == c) for c in CORE]
check("code volume flat, ~715-800 mean lines", 715 <= min(locs) <= 717 and 799 <= max(locs) <= 801,
      f"{min(locs):.1f}-{max(locs):.1f}")
mp = load_csv(f"{BATCH}/model-profiles.csv")
lifts = sorted(float(r["tool_lift"]) for r in mp)
check("tool lift spans +0.0 to +36.7", lifts[0] == 0.0 and lifts[-1] == 36.7)

print("== committed statistics files (re-parse) ==")
st = open("paper/stats-results.txt", encoding="utf-8").read()
for label, frag in [
        ("P1 +12.26 [+7.04, +17.47], Holm .0006", "effect = +12.26  95% CI [+7.04, +17.47]  perm p = 0.0001  Holm p = 0.0006"),
        ("P2 +0.13 [+0.10, +0.16]", "effect = +0.13  95% CI [+0.10, +0.16]"),
        ("P3 +0.80 [+0.73, +0.87]", "effect = +0.80  95% CI [+0.73, +0.87]"),
        ("P4 +6.88 [+0.83, +13.41], Holm .0826", "effect = +6.88  95% CI [+0.83, +13.41]  perm p = 0.0413  Holm p = 0.0826"),
        ("P5 -0.67 [-13.67, +12.67]", "effect = -0.67  95% CI [-13.67, +12.67]"),
        ("P6 +15.33 [+7.33, +24.00], Holm .0675", "effect = +15.33  95% CI [+7.33, +24.00]  perm p = 0.0225  Holm p = 0.0675"),
        ("S1 +2.41 [-0.38, +5.21]", "effect = +2.41  95% CI [-0.38, +5.21]"),
        ("S2 +4.98 [-1.42, +11.75]", "effect = +4.98  95% CI [-1.42, +11.75]"),
        ("S3 -2.17 [-12.50, +7.33]", "effect = -2.17  95% CI [-12.50, +7.33]"),
        ("S4a -3.60 [-11.36, +3.61]", "effect = -3.60  95% CI [-11.36, +3.61]"),
        ("S4b -0.02 [-0.07, +0.03]", "effect = -0.02  95% CI [-0.07, +0.03]"),
        ("S5 -16.07 [-31.67, -1.70]", "effect = -16.07  95% CI [-31.67, -1.70]")]:
    check(f"stats-results: {label}", frag in st)
ft = open(f"{FZ}/freeze-tables.txt", encoding="utf-8").read()
for label, frag in [
        ("token medians (8 conditions)", "median=213,878"),
        ("no_verification median 261,602", "median=261,602"),
        ("execution median 615,296", "median=615,296"),
        ("delayed median 1,198,829", "median=1,198,829"),
        ("spread: execution 148,922", "median_cell_sd=148,922"),
        ("spread: delayed 407,777", "median_cell_sd=407,777")]:
    check(f"freeze-tables: {label}", frag in ft)

print("== wiring defects concentrate in two models (wiring_report.csv) ==")
wr = load_csv(f"{FZ}/wiring_report.csv")
BLOCKS = ["claude-4.6-sonnet", "gpt-5.5", "claude-4.8-opus",
          "gemini-3.1-pro", "claude-4.6-opus", "grok-4.3"]


def model_of(app_path):
    """Run ids are assigned in blocks of five, one block per model."""
    m = re.search(r"/runs/(\d+)/", app_path)
    return BLOCKS[(int(m.group(1)) - 1) // 5] if m else None


wr_by = defaultdict(Counter)
for r in wr:
    mo = model_of(r["app"])
    if mo:
        wr_by[r["status"]][mo] += 1
pnl, ajs = wr_by["PROXY_NOT_LOADED"], wr_by["API_JS_COLLISION"]
check("claude-4.6-opus has 16 of the 22 proxy-not-loaded cases",
      sum(pnl.values()) == 22 and pnl["claude-4.6-opus"] == 16,
      f"total={sum(pnl.values())} opus46={pnl['claude-4.6-opus']}")
check("claude-4.8-opus has 14 of the 16 api.js collisions",
      sum(ajs.values()) == 16 and ajs["claude-4.8-opus"] == 14,
      f"total={sum(ajs.values())} opus48={ajs['claude-4.8-opus']}")
check("grok-4.3 produced no wiring defects at all",
      all(c["grok-4.3"] == 0 for k, c in wr_by.items()
          if k in ("PROXY_NOT_LOADED", "API_JS_COLLISION", "NO_PROXY_CONFIG", "PORT_MISMATCH")))
check("only the data-directory scanner produced undecided cases",
      not any(r["status"] == "UNKNOWN" for r in wr)
      and sum(1 for r in load_csv(f"{FZ}/datadir_report.csv") if r["status"] == "UNKNOWN") == 5)

print("== structural idioms, additional checks (architecture-report.csv) ==")
ar = load_csv(f"{BATCH}/architecture-report.csv")
for r in ar:
    r["model"] = norm(r["model"])


def share(model, field, value):
    sub = [r for r in ar if r["model"] == model]
    return sum(1 for r in sub if r[field] == value), len(sub)


n, d = share("grok-4.3", "vite_invocation", "positional")
check("grok-4.3 uses the positional launch in 75% of runs", (n, d) == (140, 186), f"{n}/{d}")

print("== heaviest probes: pass rates by tool group (automatic_probes_results.jsonl) ==")
HEAVY_GROUP = {"execution": "shell", "visual": "shell", "visual_no_shell": "shell",
               "delayed_verification": "shell", "boot_check": "boot_check",
               "no_verification": "blind", "static": "blind"}
hg, hc = defaultdict(lambda: [0, 0]), defaultdict(lambda: [0, 0])
heavy_names = set()
with open(f"{FZ}/automatic_probes_results.jsonl", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        o = json.loads(line)
        pr = o.get("probes") or {}
        if not pr or not o.get("boot_ok"):
            continue
        cond = o.get("condition")
        g = HEAVY_GROUP.get(cond)
        for n, v in pr.items():
            w = v.get("weight", 1)
            if w < 3:                      # the grader's own difficulty scale
                continue
            heavy_names.add(n)
            for bucket in ([hg[g]] if g else []) + [hc[cond]]:
                bucket[1] += w
                bucket[0] += w * bool(v.get("ok"))
rate = lambda b: round(100 * b[0] / b[1], 1)
check("eleven probes carry weight 3 or 4", len(heavy_names) == 11, str(sorted(heavy_names)))
check("heaviest-probe pass rates 92.0 shell / 91.1 boot probe / 89.1 blind",
      (rate(hg["shell"]), rate(hg["boot_check"]), rate(hg["blind"])) == (92.0, 91.1, 89.1),
      f"{rate(hg['shell'])}/{rate(hg['boot_check'])}/{rate(hg['blind'])}")
check("execution leads and behavioral trails on the heaviest probes",
      rate(hc["execution"]) == 93.6 and rate(hc["behavioral"]) == 83.7,
      f"execution={rate(hc['execution'])} behavioral={rate(hc['behavioral'])}")

print("== log explorer, per-model gaps (Table VIII) ==")
le = [r for r in rs if r["task"] == "log-explorer-perf"
      and r["condition"] in ("no_verification", "execution")]
per = defaultdict(lambda: defaultdict(list))
launched = defaultdict(lambda: defaultdict(lambda: [0, 0]))
for r in le:
    if r["human_pct_current"]:
        per[r["model"]][r["condition"]].append(float(r["human_pct_current"]))
    cell = launched[r["model"]][r["condition"]]
    cell[1] += 1
    cell[0] += r["runs_via_declared_path"] == "True"
gaps = {m: round(mean(v["execution"]) - mean(v["no_verification"]), 1) for m, v in per.items()}
check("gemini-3.1-pro's gap is the full +100", gaps.get("gemini-3.1-pro") == 100.0,
      str(gaps.get("gemini-3.1-pro")))
check("none of gemini's five blind builds started, all five shell builds did",
      launched["gemini-3.1-pro"]["no_verification"] == [0, 5]
      and launched["gemini-3.1-pro"]["execution"] == [5, 5])
check("two models are flat and two are negative on this task",
      sorted(gaps.values()) == [-20.0, -5.0, 0.0, 0.0, 17.0, 100.0], str(sorted(gaps.values())))


if SKIP_TREE:
    bad = [c for c in checks if not c[1]]
    print(f"\n(run-tree scans skipped) {len(checks)} checks, {len(bad)} discrepancies")
    sys.exit(1 if bad else 0)

print("== per-run manifests (identity + nudges; scans 1,116 files) ==")
mans = glob.glob(f"{BATCH}/*/*/runs/*/smoke/logs/manifest.json")
check("1,116 manifests on disk", len(mans) == 1116, str(len(mans)))
base = hashlib.sha256(open("agent-interface/base-prompt.txt", "rb").read()).hexdigest()[:16]
brief = hashlib.sha256(open("agent-interface/briefing-universal.txt", "rb").read()).hexdigest()[:16]
specs = {hashlib.sha256(open(s, "rb").read()).hexdigest()[:16] for s in glob.glob("specs/*.txt")}
nudged = multi = nudged_unfinished = 0
nudged_by_model = {}
bases, briefs, tasks = set(), set(), set()
MAN = {}          # (task, condition, run_id) -> the fields the later checks need
for p in mans:
    d = json.load(open(p, encoding="utf-8"))
    bases.add(d["base_prompt_sha"]); briefs.add(d["condition_briefing_sha"]); tasks.add(d["task_sha"])
    parts = p.replace("\\", "/").split(f"{BATCH}/")[1].split("/")
    tu = d.get("total_tokens_used") or {}
    MAN[(parts[0], parts[1], parts[3])] = dict(
        total=tu.get("total_tokens"), prompt=tu.get("prompt_tokens"),
        completion=tu.get("completion_tokens"), steps=d.get("steps"),
        status=d.get("status"), cap=d.get("max_total_tokens"),
        workspace=d["workspace"], sysp=d["system_prompt_sha"])
    n = d.get("finish_nudges", 0)
    if n > 0:
        nudged += 1
        m = d.get("model")
        nudged_by_model[m] = nudged_by_model.get(m, 0) + 1
        if n > 1:
            multi += 1
        if d.get("status") != "finished":
            nudged_unfinished += 1
check("base prompt hash identical in all runs and matches the committed file",
      bases == {base})
check("briefing hash identical in all runs and matches the committed file",
      briefs == {brief})
check("the 7 committed specs hash to the 7 task_sha values", tasks == specs and len(specs) == 7)

tmpl = open("agent-interface/base-prompt.txt", encoding="utf-8").read()
brief_txt = open("agent-interface/briefing-universal.txt", encoding="utf-8").read()
sysp_ok = sysp_n = 0
for d in MAN.values():
    resolved = tmpl.replace("{workspace}", d["workspace"]) + "\n\n" + brief_txt
    sysp_n += 1
    if hashlib.sha256(resolved.encode("utf-8")).hexdigest()[:16] == d["sysp"]:
        sysp_ok += 1
check("every run's system_prompt_sha rebuilds from published template + recorded path + briefing",
      sysp_ok == sysp_n == 1116, f"{sysp_ok}/{sysp_n}")
check("exactly 29 runs nudged, none more than once, all finished",
      nudged == 29 and multi == 0 and nudged_unfinished == 0,
      f"nudged={nudged} multi={multi} unfinished={nudged_unfinished}")
check("nudges by model 20/4/3/2 (gpt-5.5 / 4.6-sonnet / grok-4.3 / 4.8-opus)",
      nudged_by_model == {"gpt-5.5": 20, "claude-4.6-sonnet-anthropic": 4,
                          "grok-4.3": 3, "claude-4.8-opus-anthropic": 2},
      str(nudged_by_model))

print("== shell-only runs vs browser tooling (scans 252 command logs) ==")
pat = re.compile(r"playwright|puppeteer|headless|chromium|\.screenshot\s*\(", re.I)
cmds = glob.glob(f"{BATCH}/*/execution/runs/*/smoke/logs/commands.json") + \
       glob.glob(f"{BATCH}/*/delayed_verification/runs/*/smoke/logs/commands.json")
check("252 shell-only command logs", len(cmds) == 252, str(len(cmds)))
hits = sorted(f.replace("\\", "/") for f in cmds if pat.search(open(f, encoding="utf-8", errors="replace").read()))
EXPECT = sorted([
    f"{BATCH}/kanban-board/delayed_verification/runs/16/smoke/logs/commands.json",
    f"{BATCH}/kanban-board/delayed_verification/runs/17/smoke/logs/commands.json",
    f"{BATCH}/kanban-labels-brownfield/execution/runs/17/smoke/logs/commands.json"])
check("Puppeteer appears in exactly the 3 runs named in the paper", hits == EXPECT,
      f"found {len(hits)}")
check("no screenshot call in any shell-only log",
      not any(re.search(r"\.screenshot\s*\(", open(f, encoding="utf-8", errors="replace").read())
              for f in cmds))

print("== self-provisioned verification tooling (all 426 shell-holding runs) ==")
INSTALL = re.compile(r"\b(?:npm (?:install|i|add)|npx|yarn add|pnpm add|pip install)\b", re.I)
CATS = {"sight": re.compile(r"puppeteer|playwright|selenium|chromium|capture-website|webdriver|xvfb", re.I),
        "other": re.compile(r"\bjest\b|vitest|\bmocha\b|\bchai\b|supertest|jasmine|\bava\b|cypress|"
                            r"testing-library|eslint|prettier|jshint|autocannon|artillery|\bk6\b|loadtest", re.I)}
vis_cmds = glob.glob(f"{BATCH}/*/visual/runs/*/smoke/logs/commands.json")
sight_runs, other_runs = set(), set()
for f in cmds + vis_cmds:
    for c in json.load(open(f, encoding="utf-8")):
        if c["tool"] != "run_command":
            continue
        h = c.get("args_head", "")
        if INSTALL.search(h):
            run = f.replace("\\", "/").split(f"{BATCH}/")[1].rsplit("/smoke")[0]
            if CATS["sight"].search(h):
                sight_runs.add(run)
            if CATS["other"].search(h):
                other_runs.add(run)
EXPECT_SIGHT = {"kanban-board/delayed_verification/runs/16", "kanban-board/delayed_verification/runs/17",
                "kanban-board/visual/runs/16", "message-board/visual/runs/19",
                "metrics-dashboard/visual/runs/18"}
check("browser tooling installed in exactly the 5 gemini runs named in the paper",
      sight_runs == EXPECT_SIGHT, f"found {sorted(sight_runs)}")
check("no model installed test/lint/load tooling in any shell-holding run",
      not other_runs, f"found {sorted(other_runs)}")

IMG = re.compile(r"jimp|sharp\b|pngjs|tesseract|\bocr\b|pixelmatch|getImageData|createCanvas|"
                 r"image-size|opencv|\bPIL\b|pillow|imagemagick", re.I)
bhv_cmds = glob.glob(f"{BATCH}/*/behavioral/runs/*/smoke/logs/commands.json")
img_logs = cmds + vis_cmds + bhv_cmds
img_hits = sorted(f.replace("\\", "/") for f in img_logs
                  if any(IMG.search(c.get("args_head", "")) for c in json.load(open(f, encoding="utf-8"))))
check("no run computed facts about a screenshot: image-analysis tooling in none of the 450 logs",
      not img_hits and len(img_logs) == 450,
      f"logs={len(img_logs)} hits={img_hits[:3]}")

print("== delayed_verification: discovery after the first finish (60 runs) ==")
SHELL = {"run_command", "run_background_command", "run_command_and_capture_output",
         "list_background_commands", "stop_background_command"}
EDIT_TOOLS = {"write_file", "edit_file"}
dv = glob.glob(f"{BATCH}/*/delayed_verification/runs/*/smoke/logs/manifest.json")
dv_scores = {(r["task"], r["run_id"]): float(r["functional_pct"])
             for r in rs if r["condition"] == "delayed_verification" and r["functional_pct"] != ""}
unlocked = used = edited = 0
f_edit, f_clean = [], []
for p in dv:
    d = json.load(open(p, encoding="utf-8"))
    u = d.get("verification_unlocked_at_step")
    if u is None:
        continue
    unlocked += 1
    post = [c for c in json.load(open(p.replace("manifest.json", "commands.json"), encoding="utf-8"))
            if c.get("step", 0) > u]
    if any(c["tool"] in SHELL for c in post):
        used += 1
    parts = p.replace("\\", "/").split(f"{BATCH}/")[1].split("/")
    score = dv_scores.get((parts[0], parts[3]))
    if any(c["tool"] in EDIT_TOOLS for c in post):
        edited += 1
        if score is not None:
            f_edit.append(score)
    elif score is not None:
        f_clean.append(score)
check("all 60 delayed runs unlocked and used the shell; 45 edited code afterwards",
      len(dv) == 60 and unlocked == 60 and used == 60 and edited == 45,
      f"n={len(dv)} unlocked={unlocked} used={used} edited={edited}")
check("unchanged re-finishes score ~7 functional points above edited ones (97.1 vs 90.1)",
      round(sum(f_clean) / len(f_clean), 1) == 97.1 and round(sum(f_edit) / len(f_edit), 1) == 90.1,
      f"clean={sum(f_clean)/len(f_clean):.1f} edited={sum(f_edit)/len(f_edit):.1f}")

if not SKIP_TREE:
    print("== token accounting from the manifests ==")
    vals = [m for m in MAN.values() if m["total"]]
    check("every run ended by calling finish, none stopped by a budget",
          {m["status"] for m in MAN.values()} == {"finished"}
          and sum(1 for m in vals if m["cap"] and m["total"] >= 0.9 * m["cap"]) == 5)
    check("the token cap was not a single fixed budget",
          len({m["cap"] for m in MAN.values()}) > 1, str(sorted({m["cap"] for m in MAN.values()})))

    def med(v):
        v = sorted(v)
        n = len(v)
        return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2

    surv = {(r["task"], r["condition"], r["run_id"]): r["runs_via_declared_path"] == "True" for r in rs}
    nv_ok = [m["total"] for k, m in MAN.items() if k[1] == "no_verification" and m["total"] and surv.get(k)]
    nv_bad = [m["total"] for k, m in MAN.items() if k[1] == "no_verification" and m["total"] and not surv.get(k)]
    check("failed blind builds cost less than successful ones (182k vs 263k)",
          round(med(nv_bad) / 1000) == 182 and round(med(nv_ok) / 1000) == 263,
          f"failed={med(nv_bad)/1000:.0f}k ok={med(nv_ok)/1000:.0f}k")
    bc = [m for k, m in MAN.items() if k[1] == "boot_check" and m["total"] and surv.get(k)]
    nv = [m for k, m in MAN.items() if k[1] == "no_verification" and m["total"] and surv.get(k)]
    check("among builds that started: 17 vs 19 steps, 195k vs 247k input",
          med([m["steps"] for m in bc]) == 17 and med([m["steps"] for m in nv]) == 19
          and round(med([m["prompt"] for m in bc]) / 1000) == 195
          and round(med([m["prompt"] for m in nv]) / 1000) == 247)
    check("started builds under the probe also write somewhat less: 13.5k vs 16.8k output tokens",
          round(med([m["completion"] for m in bc]) / 1000, 1) == 13.5
          and round(med([m["completion"] for m in nv]) / 1000, 1) == 16.8,
          f"probe={med([m['completion'] for m in bc])/1000:.1f}k blind={med([m['completion'] for m in nv])/1000:.1f}k")
    check("among builds that started the probe still costs about 49k less (214k vs 263k)",
          round(med([m["total"] for m in bc]) / 1000) == 214
          and round(med([m["total"] for m in nv]) / 1000) == 263
          and round(med([m["total"] for m in nv]) / 1000) - round(med([m["total"] for m in bc]) / 1000) == 49,
          f"probe={med([m['total'] for m in bc])/1000:.0f}k blind={med([m['total'] for m in nv])/1000:.0f}k")
    sb = {c: [m for k, m in MAN.items() if k[0] == "seat-booking" and k[1] == c and m["total"]]
          for c in ("behavioral", "execution")}
    check("the behavioral arm stopped early: 369k vs 810k tokens, 22 vs 49 steps",
          round(med([m["total"] for m in sb["behavioral"]]) / 1000) == 369
          and round(med([m["total"] for m in sb["execution"]]) / 1000) == 810
          and med([m["steps"] for m in sb["behavioral"]]) == 22
          and med([m["steps"] for m in sb["execution"]]) == 49)
    check("yet wrote a similar amount of code: 22.0k vs 21.8k output tokens (seat-booking)",
          round(med([m["completion"] for m in sb["behavioral"]]) / 100) == 220
          and round(med([m["completion"] for m in sb["execution"]]) / 100) == 218,
          f"behavioral={med([m['completion'] for m in sb['behavioral']])/1000:.1f}k "
          f"execution={med([m['completion'] for m in sb['execution']])/1000:.1f}k")

if WITH_TRACES:
    print("== screenshot channel is passive (visual + visual_no_shell traces) ==")
    traces = glob.glob(f"{BATCH}/*/visual/runs/*/smoke/logs/trace.jsonl") + \
             glob.glob(f"{BATCH}/*/visual_no_shell/runs/*/smoke/logs/trace.jsonl")
    LIMIT = re.compile(r"can(?:not|'t) (?:click|interact|drag|hover|type|resize)"
                       r"|screenshot (?:tool )?can(?:not|'t)", re.I)
    calls = 0
    urls, beyond_runs, harness_runs, said = set(), set(), set(), set()
    beyond = 0
    argkeys = set()
    HARNESS = re.compile(r"/[a-z0-9_\-]*(test|preview|demo|debug|seed|check|validate|shot|dark|"
                         r"light|narrow|tablet|mobile|responsive|viewport|bottom|scroll|geometry)"
                         r"[a-z0-9_\-]*\.html", re.I)
    for p in traces:
        run = p.replace("\\", "/").split(f"{BATCH}/")[1].rsplit("/smoke")[0]
        for line in open(p, encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if LIMIT.search(m.get("text") or ""):
                said.add(run)
            for tc in (m.get("tool_calls") or []):
                if tc.get("name") != "screenshot":
                    continue
                a = tc.get("arguments") or {}
                argkeys.update(a.keys())
                u = a.get("url", "")
                calls += 1
                urls.add(u)
                if re.sub(r"^\w+://[^/]+", "", u) not in ("", "/"):
                    beyond += 1
                    beyond_runs.add(run)
                if HARNESS.search(u):
                    harness_runs.add(run)
    check("264 sight-condition runs traced", len(traces) == 264, str(len(traces)))
    check("the screenshot tool takes only a url", argkeys == {"url"}, str(sorted(argkeys)))
    check("1,326 screenshot calls to 260 distinct URLs",
          calls == 1326 and len(urls) == 260, f"{calls} calls, {len(urls)} urls")
    check("512 calls (39%) went beyond the application root", beyond == 512, str(beyond))
    check("110 runs used such a URL; 67 built a page purely to photograph",
          len(beyond_runs) == 110 and len(harness_runs) == 67,
          f"{len(beyond_runs)} / {len(harness_runs)}")
    check("21 runs stated an interaction limit in their reasoning", len(said) == 21, str(len(said)))

    print("== granted tools that went unused (tool_uptake) ==")
    KEYS = {"boot_check": ["check_boot"], "static": ["run_lint", "run_typecheck"],
            "visual": ["screenshot"], "visual_no_shell": ["screenshot"],
            "behavioral": ["run_tests"],
            "execution": ["run_command", "run_background_command", "run_command_and_capture_output"],
            "delayed_verification": ["run_command", "run_background_command",
                                     "run_command_and_capture_output"]}
    unused = Counter()
    totals = Counter()
    with open(f"{FZ}/merged_results.jsonl", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            o = json.loads(line)
            cond, mo = o.get("condition"), norm(o.get("model") or "")
            if cond not in KEYS:
                continue
            totals[(cond, mo)] += 1
            tu = o.get("tool_uptake") or {}
            if sum(tu.get(k, 0) for k in KEYS[cond]) == 0:
                unused[(cond, mo)] += 1
    claude = [m for m in BLOCKS if m.startswith("claude")]
    check("the three Claude models used every granted tool in all 462 of their tool-granted runs",
          sum(unused[(c, m)] for (c, m) in totals if m in claude) == 0
          and sum(totals[(c, m)] for (c, m) in totals if m in claude) == 462,
          f"unused={sum(unused[(c, m)] for (c, m) in totals if m in claude)} "
          f"total={sum(totals[(c, m)] for (c, m) in totals if m in claude)}")
    check("grok-4.3 accounts for 55 of the 100 non-use runs",
          sum(unused.values()) == 100
          and sum(v for (c, m), v in unused.items() if m == "grok-4.3") == 55,
          f"total={sum(unused.values())} grok={sum(v for (c, m), v in unused.items() if m == 'grok-4.3')}")
    check("the linter went unused in 44 of 192 static runs, screenshots in 47 of 174 visual runs",
          sum(v for (c, m), v in unused.items() if c == "static") == 44
          and sum(v for (c, m), v in unused.items() if c == "visual") == 47)

bad = [c for c in checks if not c[1]]
print(f"\n{len(checks)} checks, {len(bad)} discrepancies")
sys.exit(1 if bad else 0)
