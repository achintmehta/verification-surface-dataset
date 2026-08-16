# Defect specimen log — batch-20260613 manual grading

*Running catalog of notable defects found during hand grading, with hypothesis relevance.
Started 2026-07-03 (calendar-week-view + metrics-dashboard phases). Add new specimens at
the bottom of §1; keep the run's scorecard `notes` field as the primary record and this
file as the cross-run index.*

Three kinds of entries, kept separate on purpose:
§1 artifact defects (data — feed the paper), §2 model idioms (cross-run patterns),
§3 instrument bugs found and fixed (methods/threats), §4 grading-environment traps
(procedure only — never data, never scores).

---

## 1. Artifact defect specimens

| # | run | model | cond | defect (one line) | visible to |
|---|---|---|---|---|---|
| S1 | calendar execution/22 | claude-4.6-opus | execution | vite proxy `'/api'` (no trailing slash) swallows the app's own `/api.js` module → dev server cannot render the UI; API + layout math fully correct (model unit-tested layout via `test-layout.js`, never rendered a page) | human w/ browser only |
| S2 | calendar visual/1 | claude-4.6-sonnet | visual | same proxy-swallow in dev path; shipped prod bundle works BUT was baked with API base `:3002` while its own server defaults to `:3001` — the model verified only the one config it happened to run | human only |
| S3 | calendar execution/28 | grok-4.3 | execution | `Math.max/min(Date, Date)` → Number, then `.getHours()` on it → TypeError; **zero events ever render** despite a fully correct API | human only (API probes pass) |
| S4 | calendar no_verification/29 | grok-4.3 | no_verification | identical clamp bug (direct-variable form, `visibleStart`/`visibleEnd`) — same model, same idiom, different condition (temp-0 stability) | human only |
| S5 | calendar execution/2 | claude-4.6-sonnet | execution | `#time-labels` gutter spans the full grid (DOMRect 1531×1440 @ 0,0) without `pointer-events:none` → **every** grid interaction silently intercepted; page renders pixel-perfect; drag-create/edit unreachable | human interaction only — **passive screenshots would score it flawless** |
| S6 | calendar static/26 | grok-4.3 | static | shipped parse-broken `frontend/src/main.js` (botched edit splice `}e = 'hour-line';` at line 96); frontend unbuildable/unrenderable by any declared path; `tool_uptake` shows `run_lint: 1` — the one surface designed to catch this was granted, used once, and the file shipped broken anyway | static scan caught it (`static_defects`); human confirms unrenderable |
| S7 | metrics boot_check/6 | gpt-5.5 | boot_check | permanent false "Dashboard data is unavailable" banner: `.error-state { display:grid }` (styles.css:136) defeats the `hidden` attribute; JS show/hide logic is correct, all API loads succeed | human only — boot probe truthfully said "listens"; API perfect |
| S8 | metrics boot_check/29 | grok-4.3 | boot_check | SQL type error at request time: schema stores `date TEXT` (index.js:27) but the summary query computes `MAX(date) - INTERVAL '6 days'` (index.js:151-156) → `operator does not exist: text - interval`; `/api/summary` 500s, summary-dependent UI absent | first API call — an API probe module WOULD catch this (unlike S5/S7); boot probe cannot |

**Why these matter (H3 mechanism catalog).** S1–S5 and S7 are all *rendered-layer* or
*interaction-layer* defects sitting on top of correct APIs: exactly the failure class the
visual conditions exist to expose, observed in the wild during condition-blind grading.
S5 is the flagship threats-to-validity exhibit: an event-driven bug that even the visual
arm's **passive** screenshot tool cannot see (screenshots render; they do not click) —
cite alongside the Coding-with-Eyes event-driven argument; our visual arm is a lower
bound on the value of sight. S6 is the static arm's counterexample-in-miniature:
granted ≠ used ≠ heeded ("verify the verification").

**S8 carries a different lesson than the rest:** it is *API-observable* — a functional
probe module for metrics-dashboard would catch it mechanically, no human or renderer
needed. It looks "visual" only because that module doesn't exist yet. Its real relevance
is H5/H1's boundary: boot_check verifies "listens," not "works" — the cheap signal's
value stops exactly where request-time defects begin. (Also an argument for building the
metrics/calendar probe modules flagged as future work.)

**Cross-condition idiom pair (S3/S4 + contrast).** grok-4.3 reaches for the date-clamp
idiom in every calendar arm; fatal in execution/28 and no_verification/29, but both
`visual_no_shell` replicates wrap the clamp in `new Date(...)` (the correct form).
Suggestive of sight-driven repair, but adjudicate via graded `visual_pct` cells, not
grep (the static scan misses property-indirected forms, e.g. S3's `_start:` assignment).

---

## 2. Model idioms at temperature 0 (batch-wide scan: `grading-hazards.csv`, 52 runs)

- **Class A — proxy swallows own module (20 runs):** root-level `api.js` next to a vite
  proxy rule `'/api'` without trailing slash. Clusters hard on claude-4.8-opus (run ids
  11–15) across tasks; also 4.6-sonnet, others. Symptom: MIME-type error or 404 for
  `/api.js`; dev path unrenderable. Grading accommodation: declared prod path
  (backend-served dist, or `npm run build` + `vite preview`) — zero source edits.
- **Class B — positional root skips config (32 runs):** dev script `vite client` /
  `vite frontend` makes Vite resolve config from the positional root, ignoring the root
  `vite.config.js` that holds the proxy. Clusters on claude-4.6-opus (ids 21–25).
  Symptom: API 404s / HTML-for-JSON through the frontend port. Accommodation: launch
  bare `npx vite` from the config's directory (the app's own config, honored).
- **Caveat for blinding:** these idioms are model-recognizable mid-grading; discipline is
  to score strictly against rubric text. Note in methods that partial unblinding via
  code idioms is inherent to hand-grading temp-0 artifacts.

---

## 3. Instrument bugs found and fixed during this batch (methods / threats-to-validity)

| bug | impact before fix | fix | residue |
|---|---|---|---|
| grader installed npm deps at workspace root only; artifacts nest manifests (`app/`, `client/`+`server/`) | **458 spurious autofails**, incl. 100% of no_verification/static cells (324 runs) — would have fatally inflated every verification effect | `stage()` installs every manifest dir; entry detection via package roots + `main`/start-script hints; boot from entry's package root | 397/458 recovered; 61 legitimate autofails remain; H1/H5 re-derived on corrected data |
| entry misdetection: SSE-string fallback booted non-entry modules (e.g. `server/src/sse.js`) | boot "crashes" with empty logs (class `other`) | package.json hints precede the fallback | — |
| dir-assumption retry only fired if the process died within 3 s; PGLite's slow WASM load crashed later | `missing_path` boot failures despite the registered accommodation | late-crash retry after `no_listen`, same one-retry guard | e.g. calendar execution/4 recovered |
| frontend_probe installed/read config at app root only | false `needs_install` / `no_frontend_dev`; many GRADE_BACKEND misroutes | nested-vite fallback (mirrors grader fix); failure logs kept (`.probe_dev.log`) | many runs reclassified `frontend_up` |
| grading env ran Node 18 (EOL); artifacts pinning current Vite require Node 20.19+/22 | false `no_frontend` cluster (fast exits, empty error column — Vite's `CustomEvent` crash) | grading env standardized on Node 22; failure piles re-probed / re-graded | document: one Node version for all runs; artifacts booting under 18 also boot under 22 |

**Paper note:** the provisioning bug is itself evidence for how easily "artifact quality"
measurements conflate instrument failure with model failure; the grade-as-shipped +
uniform-accommodation protocol is what made the error detectable and reversible
(fingerprints proved zero source edits; per-run accommodation notes record every
grader intervention).

---

## 4. Grading-environment traps (procedure; never score these against a run)

1. **Stale processes** — previous run's backend/Vite still owns 3000/3001/5173; symptoms:
   404s from a server lacking this app's routes, EADDRINUSE, wrong app behind the proxy.
   Kill-sweep between runs (`pkill -f 'node server'; pkill -f vite; pkill -f concurrently`);
   verify with `ss -ltnp` + `readlink /proc/<pid>/cwd`.
2. **Browser cache across runs** — all apps share the `localhost` origin; cached HTML from
   run N-1 404s its modules under run N (`api.js`/`app.js` 404s, MIME errors). Keep
   DevTools open with **Disable cache**; hard reload; verify via view-source.
3. **PGLite WASM traps** — `RuntimeError: unreachable` (initdb on DrvFS `/mnt/d`) or
   `Aborted()` (loading a shipped `pgdata`/`pglite-data` from the model's session).
   Always environment: grader proved boot with fresh DB on ext4. Fix: rsync to
   `~/grade-stage` excluding `node_modules` + all data dirs, reinstall, run there.
4. **npm EPERM on DrvFS** — reinstalling over existing node_modules on `/mnt/d` from WSL;
   rm -rf node_modules + lockfile, or stage to ext4.
5. **Startup race** — `concurrently` brings Vite up before the backend listens; loading
   the page in the gap yields error states that may persist (or, in apps without retry,
   an empty UI that invites mis-scoring). Wait for the backend's "listening" line.
6. **Double-start collisions** — apps whose `dev` script runs backend+frontend collide
   with a manually started backend. One launch method per app.

**The decision rule that generalizes:** *server answers = provisioning is fine; what it
answers with is the artifact's responsibility.* Before scoring any failure, prove which
side of that line it sits on (backend log + direct `curl` before opening the browser).
