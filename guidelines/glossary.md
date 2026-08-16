# Glossary

Canonical definitions for every term used across the study's code, docs, and (eventually) the paper. When two documents disagree, this file wins; when this file changes, update the others. Terms are grouped by topic; cross-references in *italics*.

## Experiment structure

**Verification surface** — the set of tools through which a model can observe the consequences of its own code while working (run it, lint it, boot it, screenshot it). The study's independent variable.

**Condition** — one named verification surface, defined as a tool list in `harness/conditions.py`. The treatment. A run belongs to exactly one condition; the condition determines which tool schemas the model receives and nothing else.

**Core ladder** — the five conditions run on every *spec*, forming a monotone dose-response of verification surface: `no_verification → static → boot_check → execution → visual`.

**Targeted condition** — a condition run only on specs where it is diagnostic: `visual_no_shell` (calendar, dashboard), `delayed_verification` (kanban, seat-booking), `behavioral` (seat-booking).

**no_verification** — the baseline condition: file tools only, nothing executes, nothing observed. Formerly named *blind* (renamed: collision with InteractWeb-Bench's unrelated "blind execution," vision-literature ambiguity, and imprecision — what the baseline lacks is *any* verification, not sight). Legacy manifests may still say `blind`, `none`.

**Retired condition** — a condition name the CLI rejects: `none` and `blind` (→ no_verification), `self_built` (→ execution). Archived manifests keep old names; map via the `_RETIRED` registry.

**Spec / task** — one frozen task prompt (`tasks/<name>`), tool-silent, with an explicit "Acceptance Criteria (graded)" section. The seven: message-board, kanban-board, seat-booking, calendar-week-view, metrics-dashboard, kanban-labels-brownfield, log-explorer-perf. "Spec" and "task" are used interchangeably.

**Tool-silent** — property of a spec: it never mentions tools, capabilities, or verification methods. Tool orientation lives only in the *briefing*; capability definition lives only in the tool schemas.

**Run** — one execution of the agent loop for one (spec, condition, model, replicate) cell. Produces a *workspace* (the artifact) and logs (manifest, trace, commands.json).

**Replicate** — repeated runs of the same cell with a different *seed*; the unit over which within-cell variance is measured.

**Batch** — a set of runs produced by one instrument version under one briefing mode, archived together and verified together by `verify_inputs.py`.

**Cell** — one (spec × condition × model) combination; filled by its replicates.

## Prompt assembly

**Base prompt** — the constant system-prompt template (`SYSTEM_PROMPT_TEMPLATE`), tool-neutral, identical for every model/condition/task; `{workspace}` is its only substitution. Hashed as `base_prompt_sha` (template hash, workspace-independent).

**Briefing** — the paragraph appended to the base prompt describing the environment. Never part of the task text.

**Briefing mode** — which briefing a run received: `universal` (default — ONE briefing byte-identical in every condition, so the whole prompt is constant), `per_condition` (registered per-condition descriptions), `none` (ablation; no briefing). Recorded per run; one mode per batch.

**Universal briefing** — the registered condition-agnostic briefing text. Guarded in code against ever naming a specific tool (a constant sentence naming one tool would prescribe behavior in exactly one arm).

**Descriptive vs prescriptive (briefing rule)** — briefings may state what exists and environmental facts (descriptive); they may never mandate workflow, verification steps, or quality bars (prescriptive), except a single uniform encouragement identical in all arms.

**Delayed-unlock message** — the fixed message injected in `delayed_verification` runs when the first `finish` call unlocks the shell instead of ending the run.

**Finish nudge** — the one-time fixed reminder injected when a model replies with no tool call ("if complete, call finish"); separates protocol noncompliance from task failure. Counted as `finish_nudges`.

## Tools (the surfaces)

**BASE tools** — file authoring tools every condition gets: read_file, write_file, edit_file, list_dir, finish. Infrastructure, not treatment.

**finish** — the tool by which the model declares the task complete; terminal except in `delayed_verification` (first call unlocks, second ends).

**Shell surface** — run_command, run_background_command, run_command_and_capture_output, list_background_commands, stop_background_command. Granted in execution, visual, and delayed_verification (post-unlock).

**check_boot** — the boot_check condition's single tool: installs declared dependencies, boots the detected server entry, reports listening port or log head, always kills the process. The cheapest execution signal.

**start_app** — visual_no_shell's launcher: installs deps, runs the project's own dev/start script, returns serving URL(s); calling again restarts the app. The harness starts the app so the model can only look.

**start_server** — serves the workspace's static files over HTTP (visual condition helper, distinct from start_app).

**screenshot** — renders a URL in headless Chromium and returns the captured image to the model. *Passive*: it renders but cannot click, so event-driven bugs are a lower bound for visual arms. Images reach the model only via the harness's injection path (see *sight*).

**Sight** — perceived pixels in the model's context. Only the harness can grant it: screenshots are injected as `image_url` blocks solely in `VISION_CONDITIONS`. A shell-condition model that `cat`s a PNG receives text tokens, not sight.

## Grading

**Grader** — `grader/automatic_probes.py` (was grader.py): scores every artifact identically regardless of condition. Stages a fresh copy, runs the *static fidelity* scan and *static defect scan*, boots, runs *probes*. Machine-only since the 2026-07 refactor: it never touches visual scores; cards become scores only in `merge_results.py`, and the join is independently re-checked by `verify_post_merge_results.py`.

**Artifact** — the generated app (the workspace contents) at end of run. The study grades artifacts, never transcripts; manifest `status` is protocol compliance, not quality.

**Grade-as-shipped** — the rule that model-authored source is never edited before grading. The protocol may touch the *environment*, never the *source*.

**Probe** — one automated behavioral check executed against the booted artifact (e.g. "two SSE clients both receive the posted message", "8 parallel holds on one seat → exactly one wins"). Weighted; pass/fail with an evidence string. Probes target behaviors a model can't fake without implementing them.

**Functional checks / functional_pct** — the weighted share of probes passed. The machine-graded quality score. Boot failure ⇒ 0 (a score, not an exclusion).

**Fidelity / fidelity_score** — static spec-fidelity scan: mandated stack present (PGLite/Express/CORS/SSE in deps and source), no forbidden substitutes (sqlite3, websockets...). Measurable on broken code; the *escape-hatch effect*'s outcome variable. Deliberately not zeroed on boot failure.

**Visual rubric / rubric card** — the per-spec list of human-graded items (`grader/rubrics/<spec>.rubric.md` + `.rubric.json`) covering what automation can't see (layout geometry, drag-and-drop feel, responsiveness).

**Scorecard / visual-scores.json** — the fillable per-run file emitted by `automatic_probes.py --emit-scorecards`; the human grader records pass/partial/fail/skip per rubric item plus notes and grader_name.

**visual_pct** — the weighted human-graded score merged from a filled scorecard (pass=1, partial=0.5, fail=0; skip excluded). Reported separately from functional_pct, always.

**skip (rubric score)** — excluded from the denominator; reserved for *grader-side* problems only. A non-booting app scores **fail** on every item (skipping would create survivorship bias in visual_pct).

**overall_pct** — convenience mean of functional_pct and visual_pct; never a headline number.

**Condition-blind grading** — the human grades without reading manifest.json or the trace, in shuffled run order. (Unrelated to the retired condition name.)

**Accommodation** — a standardized, mechanical, source-untouched step the grader applies identically to every run: dependency install honoring the artifact's own declarations (`npm_install_run`), one retry after creating a missing directory (`dir_assumption_fixed`). Recorded as notes; each is itself a countable defect signal.

**Boot failure class** — why a non-booting artifact failed, classified from the server log: module_not_found, syntax_error, reference_error, missing_path, port_conflict, db_init_failure, other.

**Environment-class defect** — a defect about the runtime environment/packaging rather than program logic: missing dependency declarations, assumed directories, port assumptions. The baseline's predicted failure signature (H5).

**Logic-class defect** — a defect in the program itself: syntax errors, reference errors, wrong behavior.

**Static defect scan / static_defects** — execution-free detection of both defect classes (cannot be masked by boot order): `node --check` syntax errors (logic-class), undeclared imports and broken relative imports (environment/packaging-class). Analysis uses class *presence* per run, never total counts (enumeration beyond the first runtime failure is not attempted).

**Smoke test** — informal term for the original shallow API check (boot + one POST/GET + SSE header) used in the pilot; superseded by the probe suite.

## Provenance & integrity

**Manifest** — `manifest.json` per run: model, condition, tool list, briefing mode + hashes, decoding params, status, token usage, fingerprints, flags. The run's identity card.

**Trace** — `trace.jsonl`: every request (full message list), response (with per-step `latency_s`), and tool result. The complete play-by-play.

**commands.json** — compact per-run audit log: every tool call with the first 100 bytes of its command/arguments, including refused calls. Input for uptake and gating audits.

**Hash / sha** — 16-hex SHA-256 fingerprint of a text. `task_sha` (spec text), `base_prompt_sha` (template), `condition_briefing_sha` (briefing), `system_prompt_sha` (resolved whole prompt).

**Input identity** — the provable claim that across a batch only the tool schemas varied: one task_sha, one base_prompt_sha, one briefing mode with registry-matching hashes, one decoding config. Checked by `verify_inputs.py`.

**Decoding registry / DECODING_DEFAULTS** — the frozen decoding configuration (temperature 0.0, top_p 1.0, max_tokens 32768) in `harness/llm.py`. All entry points default to it; deviations are stamped `decoding_overridden` and fail batch verification. `seed` is exempt (the per-replicate variable).

**Workspace fingerprint** — end-of-run hash over all model-authored source files (deps/data/logs excluded); proves the graded artifact is byte-identical to what the model produced. `seed_fingerprint` is the same at t=0 for brownfield runs.

**harness_git** — the harness repo's commit hash recorded in every manifest; the instrument version. Never mix versions in one analysis table.

**Instrument** — the harness + grader + registered texts, collectively; "instrument version" = harness_git.

**Human contamination** — any human message injected mid-run (interactive mode). Flagged via `interactive` / `human_turns`; contaminated runs are excluded from all comparisons.

**Harness artifact** — behavior caused by limitations of the instrument rather than the model (port wrangling tax, self-kill loops, workspace pollution). Cataloged with detection signatures in `harness-artifact-detection.md` (classes 1–8).

**Gating / gating breach** — gating: the loop refuses tool calls outside the condition's list. A breach (an out-of-condition tool that actually *executed*) is a critical instrument bug; *blocked attempts* are behavioral data.

## Behavior & analysis

**Uptake / tool_uptake** — per-run counts of verification-tool calls (from commands.json); `screenshot_calls` is the headline column. Granted ≠ used.

**Noncompliance** — a run that received a surface but didn't use it (e.g. visual condition, zero screenshot calls). Stays in *ITT*; handled per-model in secondary analysis.

**Intention-to-treat (ITT)** — primary analysis: compare conditions as assigned, all runs included regardless of uptake. Estimates "what does *granting* the surface do."

**Complier analysis** — secondary, per-model: models with consistent uptake give clean contrasts; zero-uptake models render the hypothesis *untestable for that model* (never "no value"). Never pool compliers and non-compliers; never condition on uptake within a model's replicates.

**Escape-hatch effect** — the named mechanism (H2): execution tools deliver runtime friction *and* the means to dodge it, so struggling models negotiate the spec down (e.g. swapping PGLite for sqlite3, dropping the database). Distinct from reward hacking (no reward signal is being gamed — the driver is friction). Measured by fidelity_score; no_verification and static are immune by construction.

**Cheap-signal hypothesis (H5 companion)** — the question boot_check exists to answer: is most of a full shell's value just "does it even start"?

**Sight-seeking** — a non-vision-condition model attempting to reconstruct the sight channel (installing playwright/chromium, writing screenshot scripts, OCR). Counted as behavior, not excluded.

**Confabulated verification** — a model performing the verification *ritual* without information: e.g. `cat`ing a PNG (receiving truncated garbage text) then confidently describing the UI. Detected by checking that each verification claim's adjacent tool result could actually support it ("verify the verification").

**Tool neglect** — under-use of a granted tool despite uniform salience (the universal briefing). A model-attributable finding, not a prompt artifact.

**Verification theater** — umbrella term for confabulated verification and other evidence-shaped behavior without evidence.

**Port-wrangling tax** — tokens/steps spent fighting orphaned processes and occupied ports rather than engineering; a class-1 harness artifact in old runs, mitigated by the process-lifecycle tools.

**Self-kill signature** — `pkill -f node` (and kin) matching the command's own shell, killing itself every time; the mechanism behind one archived infinite loop.

**Treatment ladder / dose-response** — plotting an outcome (functional_pct, fidelity, cost) against the ordered core conditions; the study's headline figure shape.

**Briefing ablation** — runs with `briefing_mode: none`, used to measure the briefing's own effect; analyzed separately, never pooled.

**Per-protocol** — see *complier analysis* (the run-level version is biased; the per-model version is the sanctioned one).

## Hypotheses (shorthand)

**H1** — verification buys depth, not basic functionality; gaps grow with task difficulty. **H2** — escape-hatch effect (see above). **H3** — sight is only worth what only sight can see (boundary-condition claim; tested via the visual specs + visual_no_shell). **H4** — tools multiply variance (weak models thrash with bigger surfaces). **H5** — the baseline's defects are environment-class, not logic-class; boot_check eliminates most of them cheaply. **H6** — brownfield amplifies tool value (regression-safety under do-no-harm). **H7** — performance budgets are met only when measurable (log-explorer).

## Run statuses (manifest `status`)

**finished** — model called finish (in delayed_verification: the second finish). **stopped_no_tool_call** — no tool call twice in a row (after the finish nudge). **budget_exhausted** — hit max_steps. **token_budget_exhausted** — hit --max-total-tokens. **stuck_looping** — identical-call repetition or A,B,A,B cycle detected. **truncated_tool_args** — repeated unparseable tool arguments (per-turn token cap hit mid-emission), not a reasoning loop. **stuck_blocked_tool** — repeatedly called out-of-condition tools. **interrupted** — killed externally. Statuses measure *protocol*, never quality.
