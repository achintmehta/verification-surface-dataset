# App-by-app grading guide — what each spec tests, what counts, what doesn't, and why

*Companion to `research-context.md` (portfolio rationale), `grader/GRADER.md` (probe
catalogs), `grader/rubrics/*.rubric.md` (the criteria themselves), and
`defect-specimens-batch-20260613.md` (worked examples). This document explains the
intent behind each app and draws the inclusion/exclusion line a grader needs when a
run misbehaves in a way no rubric line anticipated.*

---

## The universal principles (apply to every app)

**What is always IN scope.** Anything the spec's "Acceptance Criteria (graded)" section
names, as operationalized by the probes (machine) and the rubric card (human). The
criteria were frozen before any run existed; grading is an act of *measurement against
that text*, not of software review. If the artifact fails a criterion for a reason that
lives in the artifact — wrong logic, broken rendering, dead interaction, missing
feature — it counts, whatever the underlying cause.

**What is always OUT of scope, and why:**

1. **Environment and provisioning failures.** Missing node_modules, data directories the
   app assumes, port collisions with other graded runs, filesystem quirks (DrvFS/WASM
   traps), Node-version skew. *Reason:* the briefing promised every run "dependencies
   declared in package.json files are provisioned by the environment," so failing a run
   for unprovisioned dependencies would punish it for trusting the contract. The grader
   applies identical mechanical accommodations to every run (install per manifest dir,
   one mkdir retry, fresh data dir, standardized Node); the human grader must mirror
   them. Each accommodation is *recorded* (notes: `npm_install_run`,
   `dir_assumption_fixed`) because accommodation frequency is itself H5 signal — but it
   never costs score.
2. **Launch mechanics that the artifact's own declared configuration can satisfy.**
   Class-B hazards (`vite client` skipping the root config) and grading via a declared
   prod path (build+preview, backend-served dist) are accommodations, not defects,
   *provided zero source files change*. *Reason:* grade-as-shipped protects the source,
   not the invocation; honoring the artifact's own config through a standard invocation
   measures the artifact, while refusing to would measure npm script trivia. The
   dev-path defect still goes in notes (it is real), but the rendered UI is graded from
   whatever declared path works. Only when *no* declared path can render the UI does the
   failure become scoreable (all rendered-UI items fail).

   **The configuration-space rule (formalized after batch-20260613 grading):** an
   accommodation may only *select values or paths within the artifact's own declared
   configuration space* — scripts it defines, config files it ships, environment
   variables its code reads (e.g. `PORT=3002` for a server that declares
   `process.env.PORT`, when its shipped bundle was baked against 3002). An
   accommodation may never add information the artifact does not contain. Some
   declared combination works → accommodate, grade the UI, record the defect in
   notes. No declared combination works → the rendered criteria fail (e.g. a
   parse-broken frontend). These config defects are genuinely model-authored
   inconsistencies, so why are they notes rather than scores? Three reasons:
   (a) the rubric criteria were frozen before any run existed and do not mention
   launch ergonomics — scoring them now would invent criteria mid-batch; (b)
   discovery bias — they surface only on runs the grader happened to dig into, so
   ad-hoc penalties would be applied non-uniformly and correlate with model idiom;
   (c) no instrument ever measured "the declared dev script works end-to-end"
   uniformly across all runs. The uniform way to account for them is the planned
   **declared-launch integrity** variable: extend the static hazard scan
   (`grading-hazards.csv`, which already covers classes A and B batch-wide) into a
   per-run mechanical check, and report launch-defect rates by model × condition
   as a secondary outcome.
3. **Aesthetics, taste, and polish beyond the criteria.** Color choices, typography,
   spacing rhythm, animation quality. *Reason:* no criterion names them, and taste
   judgments are exactly the grader-discretion the condition-blind design must exclude.
   If a page is ugly but meets the criterion text, it passes that item.
4. **Qualities the spec never asked for:** accessibility, security hardening, i18n,
   browser-compatibility beyond the one standardized grading browser, code style,
   architecture elegance (beyond the *fidelity scan's* mandated-stack checks, which are
   machine-graded and not the human's job). *Reason:* the study measures delivery of a
   frozen spec under varying verification surfaces; grading unrequested virtues would
   let grader values leak into the treatment contrast.
5. **Performance — except on log-explorer-perf.** Slow-but-correct is not a defect on the
   other six specs. *Reason:* performance is only *observable-by-measurement*, which is
   the modality log-explorer exists to isolate (H7); folding it into other specs would
   blur the modality axis the portfolio deliberately varies.
6. **Error-state UX beyond named criteria.** A confusing error message, a sticky banner
   (specimen S7) — notes, not scores, unless a criterion names the behavior (e.g.
   seat-booking SB-V4 *does* grade conflict UX, so there it counts). *Reason:*
   criteria-anchoring again; the notes field exists so real observations are preserved
   without inventing rubric lines mid-batch.

**The decision rule when something fails during grading:** *server answers =
provisioning is fine; what it answers with is the artifact's responsibility.* Prove
which side a failure sits on (backend log + direct curl) before scoring. When genuinely
ambiguous, score to the criterion text and record the ambiguity in notes — never bend a
pass/fail to express an opinion the rubric doesn't ask for.

---

## message-board — the calibration floor

**App.** Express + PGLite + SSE message board: post messages, list history, broadcast to
connected clients in real time.

**Purpose in the portfolio.** The easy anchor. The pilot showed every condition can
build it, so its role is *calibration*: it pins the low end of the difficulty curves
(H1/H4), and any condition gap appearing here is presumptively a harness artifact to
investigate, not verification value to report.

**Machine grades (functional_pct, 7 probes):** post accepted; history returns the post;
SSE endpoint exists; a connected client receives a new message (real broadcast); TWO
simultaneous clients both receive it (fan-out, not last-client-wins); kill-9 →
reboot → message survived (durable PGLite, not RAM); empty/missing text rejected 4xx.
*Why these:* each is a behavior a model cannot fake without implementing it; fan-out and
restart-persistence separate a real SSE+DB implementation from a plausible-looking one.

**Human grades (MB-V1..V3, weights 1/1/2):** readable list with history on first paint;
post clears input and appears without reload; cross-window realtime within ~1s.
*Why so thin:* the API probes already cover this app's substance; the rubric only adds
the rendered confirmation that the SSE plumbing reaches actual pixels. Weight lives on
V3 because client-side EventSource wiring is the only part the API can't prove.

**Excluded here:** message styling, timestamps/author displays (unless spec'd), XSS
hygiene, pagination behavior beyond history-loads. *Reason:* not in the acceptance
criteria; the floor task must stay easy to keep its calibration role clean.

---

## kanban-board — the workhorse medium task

**App.** Shared kanban board: columns, cards, drag-and-drop, fractional-position
ordering with renormalization, optimistic UI with server-authoritative reconcile, SSE.

**Purpose.** Enough moving parts for deep probes to separate conditions (H1), enough
runtime friction (PGLite quirks, dev-server management) to elicit escape-hatch behavior
(H2), the venue where pilot variance blew up (H4), and the base codebase for the
brownfield task. Also runs `delayed_verification` (commit-then-discover workflow).

**Machine grades (8 probes):** board returns ≥3 ordered columns; create lands; cross-
column move ends in exactly one place; reorder honors `afterId`; SSE endpoint; mutation
broadcast; kill-9 persistence; **ordering-integrity stress** (25 cards + 24 repeated
midpoint moves between the same neighbors → no card lost/duplicated, all positions
unique and finite). *Why the stress probe:* fractional-position schemes fail exactly
under repeated midpoint insertion (float exhaustion); it is the spec's §3.5
renormalization criterion made adversarial, and unfakeable.

**Human grades (KB-V1..V5):** real mouse drag-and-drop to a *chosen position* (not
append-only); optimistic landing with no flicker/snap-back; two-window convergence
including moving the SAME card in both; invalid-drop robustness; basic layout sanity.
*Why:* drag-and-drop is event-driven — the API-level reconcile contract is probed, but
whether a human can actually pick up and place a card only exists in a browser. KB-V2
(optimism) is the one place the *feel* of latency is a criterion, because the spec
mandates optimistic UI; don't extend that concern to other apps.

**Excluded:** column/card CRUD chrome beyond the spec, drag animation quality (only
correctness: lands where dropped, no flicker), touch support, keyboard DnD
(accessibility — unrequested), styling. *Reason:* the discriminating behaviors are
ordering integrity and reconcile correctness; decorating the rubric with UX taste would
dilute exactly the items H1 needs.

---

## seat-booking — the hard end of the API-checkable axis

**App.** Seat map with holds (TTL expiry), all-or-nothing multi-seat acquisition,
idempotent confirm, no-double-booking under concurrency, SSE transitions.

**Purpose.** H1's canonical prediction (baselines fail *here* first: concurrency
invariants are unverifiable by reading code), the cleanest escape-hatch venue (H2), and
host of the `behavioral` arm (self-authored tests) plus `delayed_verification`.

**Machine grades (13 probes)** — the acceptance criteria near-verbatim: seeded map with
valid states; hold acquire; hold blocks others (409); **all-or-nothing** (1 free + 1
held → nothing acquired); confirm books; **double-confirm books exactly once**; release
returns seats; confirming a nonexistent hold fails cleanly; **8 parallel holds on one
seat → exactly one 2xx** (the race, weight 4 — the single most diagnostic probe in the
study); seat-count invariant; SSE endpoint; transition broadcast; kill-9 persistence.
*Why:* every one is an invariant that only holds if the implementation actually
serializes state transitions; races and idempotency cannot be faked or eyeballed.

**Human grades (SB-V1..V5):** three visually distinct seat states; a **countdown that
reflects the hold's real TTL**; cross-window realtime recolor; conflict UX naming WHICH
seats failed (the one graded error-state UX in the study — the spec asks for it);
**visible expiry back to available in both windows with no manual action**. *Why SB-V5
is human-graded:* TTL expiry can't be auto-probed unless the app reads a TTL env var,
which the spec doesn't mandate — so the human waits out the clock. Budget the wait.

**Excluded:** seat-map visual design, hold-flow ergonomics beyond the named items,
payment-like flows (never spec'd), admin tooling. *Reason:* the app exists to test
atomicity under concurrency; its rubric intentionally grades only the rendered
reflections of those invariants.

---

## calendar-week-view — H3's make-or-break spec (rubric-only)

**App.** Week grid with cluster-based overlap layout: overlapping events share width
within their contention window; exact time-proportional geometry; create/edit/delete.

**Purpose.** Logically trivial API, visually demanding renderer. Failure mode: *correct
JSON, wrong picture* — the class only sight can catch. If visual conditions don't beat
execution here, sight has no measurable value anywhere in the portfolio. Also runs
`visual_no_shell` (seeing-without-running decomposition).

**Machine grades: nothing functional** (`functional_pct = null`; boot + static scans
only). *Why:* the criteria are geometric; an API probe would verify the trivial part
and miss the point. The rubric IS the grade — which is why condition-blind discipline
and item-anchored scoring matter most on this spec.

**Human grades (CW-V1..V8):** three identical-range events → equal-width side-by-side
filling the column; partial-overlap chain fully visible, width divided *only while
contended*; exact vertical geometry (edges on the gridlines); later non-overlapping
event regains FULL width; midnight-ending event stops at the column bottom; title
ellipsis containment; click/drag-create with pre-filled range + immediate edit/delete
re-render; week navigation with today indicated. *Why each:* V1–V4 are the cluster
algorithm made visible (the hard part); V5–V6 are containment discipline; V7 is the one
interaction item (conjunctive — score halves, `partial` when one half works); V8 proves
the grid re-renders rather than being a static screenshot of one week.

**Excluded:** month/day views, recurring events, timezone handling (unless spec'd),
drag-to-move existing events (only create-by-drag is named), styling taste. *Reason:*
every excluded feature is API-adjacent or taste; including them would re-blur the
visual-modality isolation this spec exists to provide. **Failures excluded:** anything
on the §Universal list — this spec collected most of the batch's environment traps
(specimens S1–S6 context), so the artifact-vs-environment line matters most here.

---

## metrics-dashboard — H3's second venue, different failure mode (rubric-only)

**App.** Seeded metrics API, hand-drawn chart, responsive grid, dark mode with
persistence, seeded edge-case values.

**Purpose.** Deliberately different visual failure mode from calendar — CSS/layout
discipline (overflow, breakpoints, containment, contrast) rather than algorithmic
geometry — so H3's conclusion doesn't hinge on one app. Also runs `visual_no_shell`.

**Machine grades: nothing functional** (rubric-only, same rationale as calendar).

**Human grades (MD-V1..V7):** 360px single column with NO horizontal scroll and nothing
clipped; 768px two-column; 1280px four-cards-in-a-row + chart/categories side by side;
chart contained at all widths and **redrawn on live resize**; the seeded over-long label
truncates and the seeded 7-digit value fits its card; dark mode restyles EVERYTHING
including chart internals with legible text; theme survives reload *and server restart*.
*Why:* the three widths are the spec's named breakpoints; V4 separates render-once from
resize-aware charts; V5 exists because the spec plants adversarial data (an app that
never renders the seeded edge cases scores `fail` there — it failed to create the test
condition, see S8-adjacent guidance); V6–V7 test that theming is systemic (chart
libraries — hand-drawn here — usually miss axes) and actually persisted server-side.

**Excluded:** chart type/beauty, additional widgets, animation, loading skeletons.
**Known measurement gap, accepted deliberately:** functional data-path failures (S8's
`text - interval` SQL error emptying the stat cards) touch the rubric only where
content is criterial (V3 partial, V5 fail) — visual_pct will overstate such runs.
*Reason for accepting it:* bending layout items to punish a functional bug would make
the visual score mean different things on different runs; the gap is recorded in notes
and argues for the future metrics probe module, not for grader improvisation.

---

## kanban-labels-brownfield — the external-validity task

**App.** A grader-validated working kanban app, pre-seeded into the workspace, plus a
change request: add labels (create/rename/recolor/delete), per-card assignment, and
multi-select filtering — *without breaking anything*.

**Purpose.** Most real engineering is modification under a do-no-harm constraint. Half
the graded criteria are regressions, so it measures whether verification tools matter
more when you must understand and preserve code you didn't write (H6). The
`seed_fingerprint` proves every condition started from the identical codebase.

**Machine grades:** the **kanban probe suite re-run verbatim** — on this spec,
functional_pct measures the *regression half* (did create/move/reorder/SSE/persistence/
ordering-stress survive the change?). *Why reuse:* the original board's behavior is the
do-no-harm contract; identical probes make "broke the board" mechanically detectable.
Label APIs are deliberately not probed (future work) — the labels half is human-graded.

**Human grades (BL-V1..V5, uniform weight 2):** chips rendered in the label's color;
full label-manager CRUD with duplicate/empty validation feedback; filtering hides
exactly non-matching cards and does NOT leak into the other window (per-client state);
realtime chip updates including delete-removes-chips-everywhere; **regression: original
drag-and-drop still smooth with chips rendered**. *Why BL-V5 despite the probes:* the
probes prove the move API still works; only a human can feel whether chip rendering
broke drag pickup/drop targets — the classic way UI additions regress DnD.

**Additionally judged (via diff, not rubric):** "extend, don't rewrite" — grading
diffs the artifact against the starter fingerprint. A full rewrite that passes
everything still fails the spirit; flag it in notes for the H6 analysis.

**Excluded:** label UX niceties (color pickers, drag-to-assign), performance, styling.
*Reason:* the treatment contrast is regression-safety vs. feature-delivery; rubric
lines beyond the spec would contaminate the H6 gap measurement.

---

## log-explorer-perf — the measurement-modality task (not in batch-20260613)

**App.** 100k seeded log rows; windowed queries with p95 latency budgets at deep
offsets; ≤200 rows per response; virtualized DOM; severity filter + search.

**Purpose.** Correctness observable *only by measurement*: a naive OFFSET scan and an
unvirtualized list return identical-looking JSON and miss every budget (H7). Prediction:
no_verification/static ship plausible-reading implementations that fail all budgets.

**Machine grades (future module):** the latency budgets at volume — needs a measurement
harness, not unit tests.

**Human grades (LE-V1..V5):** smooth scrolling through 100k rows at top/middle/bottom;
scrollbar proportional to the *filtered* total with plausible mid-drag rows; responsive
typing with no stale results; severity colors + accurate "N of total"; **DevTools check
that rendered row elements stay bounded (~100) regardless of scroll position** — the
one rubric item in the study that inspects implementation via DevTools, because DOM
virtualization is invisible in the pixels but is the spec's explicit mechanism.

**Special caution (from research-context):** the boot_check probe waits 20s but this
spec's first-boot seed budget is 60s — check the log head for seeding progress before
classing a boot_check failure here. **Excluded:** absolute latency judgments by feel
(the budgets are machine-measured; the human grades smoothness and correctness only),
log parsing features beyond spec.

---

## Quick cross-reference

| app | machine grade | human grade | primary hypotheses | the one mistake to avoid |
|---|---|---|---|---|
| message-board | 7 probes | 3 items (realtime pixels) | floor/calibration | reading any gap here as a finding |
| kanban-board | 8 probes incl. ordering stress | 5 items (DnD feel, convergence) | H1 H2 H4 | grading drag *animation* instead of drag *correctness* |
| seat-booking | 13 probes incl. 8-way race | 5 items (states, TTL, conflict UX) | H1 H2 | skipping SB-V5 because the wait is boring |
| calendar-week-view | none (rubric-only) | 8 items (geometry, containment, create) | **H3** | scoring an environment failure as an artifact failure |
| metrics-dashboard | none (rubric-only) | 7 items (breakpoints, theme, edge data) | **H3** | bending layout items to punish functional bugs |
| kanban-labels-brownfield | kanban probes = regression half | 5 items (labels UX + DnD regression) | **H6** | crediting a rewrite that passes everything |
| log-explorer-perf | future (budgets) | 5 items (smoothness, virtualization) | **H7** | judging latency by feel instead of measurement |
