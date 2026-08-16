# automatic_probes_results.jsonl — field reference

One JSON object per graded run, written by `grader/automatic_probes.py:main()`
(appended per run). The authoritative batch-level file is
`runs/<batch>/automatic_probes_results.jsonl`. Rows are MACHINE-ONLY since the
2026-07 pipeline refactor: no visual/human fields (see "Legacy merged fields"
at the bottom for the sealed freeze's older format). Rows affected by the
2026-07 provisioning fix were re-graded in place (each run's accommodation
notes record what the grader did).

Companion docs: `GRADER.md` (probe catalogs per task), and the docstring of
`merge_results.py` (inputs with provenance, the survival definition, and
the run-summary.csv / merged_results.jsonl / visual_items.jsonl output
schemas). Concept definitions: `guidelines/glossary.md`.

## Identity fields

| field | type / values | meaning | source |
|---|---|---|---|
| `run` | absolute path | run directory that was graded | CLI argument, `automatic_probes.py:main()` |
| `task` | `message-board` \| `kanban-board` \| `seat-booking` \| `generic:<spec>` | which probe module graded it. `generic:` prefix = rubric-only spec (calendar-week-view, metrics-dashboard, log-explorer-perf) or probe-module override (kanban-labels-brownfield reuses the kanban probes for its regression half, see `GENERIC_MODULE_OVERRIDES`) | `automatic_probes.py:detect_task()` from path keywords |
| `model` | model id string; `-anthropic` suffix = Anthropic API routing | which model produced the artifact | run's `manifest.json` via `automatic_probes.py:load_manifest()` (written by the harness) |
| `condition` | `no_verification` \| `static` \| `boot_check` \| `execution` \| `visual` \| `visual_no_shell` \| `delayed_verification` \| `behavioral` (legacy: `blind`, `none`, `self_built`) | the verification surface (treatment) | manifest.json |
| `run_status` | `finished` \| `stopped_no_tool_call` \| `budget_exhausted` \| `token_budget_exhausted` \| `stuck_looping` \| `truncated_tool_args` \| `stuck_blocked_tool` \| `interrupted` | protocol outcome of the agent run. **Never a quality measure** | manifest.json (harness) |

## Static scans (no execution; cannot be masked by boot order)

| field | type / values | meaning | source |
|---|---|---|---|
| `fidelity` | object of 9 booleans | mandated-stack scan: `dep_pglite`/`dep_express`/`dep_cors` (declared in any package.json), `forbidden_db_dep` (sqlite3/better-sqlite3/pg/mysql2/mongodb declared), `uses_pglite_src`, `sse_server_src` (`text/event-stream` in source), `sse_client_src` (`EventSource`), `uses_sqlite_src`, `uses_websocket_src` (socket.io/ws) | `automatic_probes.py:static_fidelity()` → `collect_package_json()` + `grep_sources()` |
| `fidelity_score` | 0.0–1.0 (eighths) | 8 equally weighted points: the 3 deps + `uses_pglite_src` + both SSE checks + NOT `forbidden_db_dep` + NOT `uses_websocket_src`. **Caveat: checklist is shared across specs — calendar/dashboard don't mandate SSE, so those runs cap at 0.75. Compare within task only.** Deliberately NOT zeroed on boot failure (the depth hypothesis needs it on broken code) | `automatic_probes.py:grade_one()` |
| `static_defects` | `{syntax_errors: [{file,error}], undeclared_imports: [{file,package}], broken_relative_imports: [{file,import}]}` | logic-class (syntax) vs environment/packaging-class (undeclared/broken imports) defects, detected without booting. Analysis uses class *presence* per run, never counts | `automatic_probes.py:static_defect_scan()` |
| `tool_uptake` | `{tool: count}` \| `null` | verification-tool calls made **during the original agent run** (granted ≠ used; noncompliance data). Tools counted: see `VERIFICATION_TOOLS`. `null` = commands.json missing/unparseable | `automatic_probes.py:tool_uptake()` reading the run's `commands.json` (harness log) |

## Execution results

| field | type / values | meaning | source |
|---|---|---|---|
| `boot_ok` | bool | staged copy booted and listened on a port, after standardized accommodations (per-manifest-dir `npm install`, one missing-dir mkdir retry incl. late-crash variant) | `automatic_probes.py:App.stage()` / `App.boot()` |
| `entry` | relative path \| `null` | detected server entry file (candidate list per package root → package.json `main`/start-script hints → SSE-string fallback) | `automatic_probes.py:App.find_entry()` |
| `port` | int \| `null` | port the booted server listened on | `App.boot()` via `free_localhost_ports_of()` |
| `probes` | `{name: {ok: bool, weight: int, evidence: str}}` | per-probe behavioral results (probe catalogs in `GRADER.md`). Empty `{}` for `generic:` rubric-only tasks and for boot failures | task modules (`MessageBoard`/`Kanban`/`SeatBooking`), driven by `grade_one()` |
| `functional_score` / `functional_max` | numbers | weighted probe points earned / possible. On boot failure `max` is still summed so `functional_pct` = 0 (a score, not an exclusion) | `grade_one()` |
| `boot_failure_class` | `module_not_found` \| `syntax_error` \| `reference_error` \| `missing_path` \| `port_conflict` \| `db_init_failure` \| `other` — **only present when boot failed** | first runtime error class from the server log (the environment-vs-logic split). `other` + note `boot_crash` = died with unmatched log text; `other` + `no_listen` = never listened within timeout | `automatic_probes.py:classify_boot_failure()` |
| `server_log` | string — only on boot failure | tail (~400 chars) of the captured boot log | `App.server_log_tail()` |

## notes[] — possible values

| note | meaning | source |
|---|---|---|
| `npm_install_run` | grader installed dependencies (accommodation; also an environment-class defect signal) | `App.stage()` |
| `npm_install_dir:<rel>` | which manifest directory was installed (post-fix; may repeat) | `App.stage()` |
| `dir_assumption_fixed:<path>` | app crashed on a missing path once; grader mkdir'd it and re-booted (registered accommodation) | `App.boot()` |
| `no_entry_found` | no server entry detected → boot not attempted | `App.boot()` |
| `boot_crash` | process died during boot | `App.boot()` |
| `no_listen` | process ran but never listened within `--timeout-boot` (default 30s) | `App.boot()` |
| `boot_failed` | summary marker for any boot failure | `grade_one()` |
| `critical_probe_failed:<name>` | a probe marked critical failed | `grade_one()` |

(The legacy notes `visual_ungraded`, `visual_scorecard_blank`,
`visual_invalid_score:<id>=<v>`, and `visual_scores_unparseable:<err>` came
from the retired in-grader merge step and no longer appear in new rows; card
problems are now reported by `verify_pre_merge_results.py` as CARD_* codes.)

## Scores

| field | type / values | meaning | source |
|---|---|---|---|
| `functional_pct` | 0–100 \| `null` | weighted share of probes passed. **`null` = not applicable** (`generic:` rubric-only spec). **`0` = boot failure or all probes failed** — kept in all ITT analyses. Machine-graded headline | `grade_one()` |

Human scores are NOT in this file. The human record lives in the cards
(`smoke/logs/visual-scores.json`) and, after the join (`merge_results.py`,
the sole card-scorer, independently re-checked by
`verify_post_merge_results.py`), in `run-summary.csv` (`human_pct_current`,
weighted: pass=1, partial=0.5, fail=0, skip excluded), `merged_results.jsonl`
(superset row), and `visual_items.jsonl` (per-item map).

## automatic_probes_results.csv

Flat per-run matrix rewritten per grader invocation: identity columns +
`boot_ok`, `functional_pct`, `fidelity_score`, `screenshot_calls` (from
`tool_uptake`), one column per probe. Regenerate from the jsonl after
re-grades — it is NOT auto-updated.

## Legacy merged fields (sealed freeze only)

`freeze-20260703/results.jsonl` predates the pipeline refactor. Its rows are
the schema above PLUS four fields produced by the retired in-grader merge:
`visual_pct` (0–100 or null, weighted human rubric score), `visual_items`
({item_id: pass|partial|fail|skip}), `visual_graded_by` (grader name, or
`auto:backend_boot_failed` for machine-autofilled non-booting runs), and
`overall_pct` (convenience mean, never a headline). The freeze stays exactly
as sealed; the refactored pipeline reproduces its run-summary.csv
byte-for-byte from the split files (guidelines/refactor-verification-report.md).
