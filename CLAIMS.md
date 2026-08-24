# CLAIMS.md: where to find every number the paper quotes

Every run in this study has a durable record: the application exactly as
the model shipped it, a manifest of settings, hashes, and token counts, and
the ordered log of every tool call. Every number the paper quotes is
computed from those records and from the graded data files built on top of
them. At 1,116 runs, it is hard to confirm that by hand, so the analysis is
scripted. The scripts that regenerate the dataset of record and the
statistical results are committed here alongside their outputs, and a
further script re-checks the paper's quoted numbers directly against the
data.

This page maps each number in the paper to the file it comes from. The
notes below say how each file can be regenerated or, where a generator is
internal, how the file's integrity is sealed instead so a claim can be
verified at whichever depth suits you: read the file, read the script that
produced it, or run the script and compare.


- **stats** = `paper/stats-results.txt` (all the statistical tests).
  Regenerable: run the committed `paper/stats_analysis.py` (standard library
  only, fixed seed 20260703) and compare its output to the committed file.
- **tables** = `freeze-20260720/freeze-tables.txt` (scores, counts, token
  costs). Produced by an internal script that is not published; its
  authenticity rests on the freeze's `SHA256SUMS` seal, and every value the
  paper quotes from it is either re-parsed or independently recomputed from
  run-summary by `verify_paper_claims.py`.
- **run-summary** = `freeze-20260720/run-summary.csv` (run metadata and
  outcomes computed from data files). Regenerable byte-for-byte from the
  published inputs by `merge_results.py`, with `verify_post_merge_results.py`
  as an independent re-check (including a card-only re-derivation of the
  survival column).
- **[output: ...]** = `verify-output-v1.2.0.txt` with the section named `...` in this file.
  Regenerable by running the script ` verify_paper_claims.py` 


A few things to know before comparing numbers yourself:

- The CSVs name the Claude models with a provider suffix
  (`claude-4.6-sonnet-anthropic`). The paper drops the suffix.
- The tables file truncates percentages (execution survival is 98.96%, printed
  as 98%). The paper reports survival to one decimal computed from the raw
  counts: 86.5 / 84.4 / 99.5 / 99.0 / 99.4 across the core five.
- Two median conventions. The sealed tables (sections 8 and 9) report the
  middle run's value (for an even count, the upper of the two middle runs).
  Medians computed directly from the manifests and quoted in the paper's text
  (182k/263k, 195k/247k input, 13.5k/16.8k output, the ~49k probe saving,
  369k/810k, 22/49 steps) are standard medians (the average of the two middle
  runs). The two differ visibly only for the behavioral arm: 375,389 in the
  sealed table versus 368,548 (369k) in the text, from the same 24 runs.
- "Survives" or "boots" means the run-summary column `runs_via_declared_path`
  is True.
- Grades: `functional_pct` is the machine score, `human_pct_current` is the
  human score.
- **Per-run logs.** Several claims are checked against the agent's own logs,
  one folder per run at
  `runs/batch-20260613/<task>/<condition>/runs/<id>/smoke/logs/`. That folder
  holds `manifest.json` (settings, token counts, step count) and
  `commands.json` (the ordered list of tool calls). The full request-response
  traces (`trace.jsonl`, one per run, roughly 5 GB in total) are not in the
  git tree: they are published as a supplementary archive in the Zenodo
  record, unpacking to these same `runs/batch-20260613/...` paths, and one
  exemplar trace per condition also ships under
  `agent-interface/example-traces/`. Rows below that cite `trace.jsonl`
  verify against the full traces; the script runs those checks only when the
  traces are present (`--with-traces`).
- **Two different hazard datasets.** Section V counts hazards the human grader
  met while grading (`grading-hazards.csv`, in the repository root, 52 rows).
  Section VI-A counts what the batch-wide static scanner found across all
  1,116 builds (`freeze-20260720/wiring_report.csv`). They measure related
  defects by different methods, so their totals are not meant to match.

## Abstract

| Number in the paper | Where it comes from |
|---|---|
| 1,116 applications, six models | run-summary has 1,116 rows, 186 per model; stats header says n=1116 |
| no tools fails to boot about 14% of the time | tables, section 1, pooled line: 26 of 192 no_verification runs failed = 13.5% |
| boot probe costs about 35% of a full shell | tables, section 8: 213,878 / 615,296 = 0.35 |
| full shell multiplies cost by 2.35 | tables, section 8: 615,296 / 261,602 = 2.35 |
| sight helps but does not survive correction | stats, P4 block: +6.88, Holm p = .0826 |

## I. Introduction

| Number | Where |
|---|---|
| the boot probe recovered nearly all the launch failures seen with no tools | run-summary: 26 of 192 no_verification runs fail the whole-app launch definition against 1 of 192 boot_check runs; tables, section 1 (full row repeated in IV-B) **[output: census and survival]** |
| boot probe gives the highest ratio of artifact quality to token usage | tables: functional 91.7 (section 2) over the lowest median tokens of all eight conditions (213,878, section 8) = 429 points per million tokens; the core-five ratios and the all-eight argument are spelled out in IV-B |
| the likeliest gains from sight over a shell alone appear where failures involve element placement or interaction | the largest visual-minus-execution human gap is the calendar's +10.9 (tables, section 3); the task's placement and interaction demands are the spec, `specs/calendar-week-view.txt`; all three gaps in IV-D **[output: score ladders]** |
| the visual advantage is modest and does not survive correction | stats, P4: +6.88, interval +0.83 to +13.41, p .0413, Holm .0826 (also the Abstract row and IV-D) |
| the gains are smaller for static page-layout issues | the dashboard's visual-minus-execution gap is +2.9 (tables, section 3; IV-D) **[output: score ladders]** |
| minimal value in detecting issues that can be measured | the log explorer's gap is -2.1: no visual gain where the spec's demands are countable (`specs/log-explorer-perf.txt`: 100,000+ rows, 200 per response); tables, section 3; IV-D **[output: score ladders]** |
| prior study: 90 runs, tool raised cost 42 to 68 percent | arXiv:2607.02436, not this archive |
| prior study: Docker failed first try in 44%, local env in 17% | arXiv:2607.02436, not this archive |

## II. Study Design

### II-A. The agent

| Number | Where |
|---|---|
| prompt, briefing, and task text identical in every run | hash `agent-interface/base-prompt.txt` and `briefing-universal.txt` yourself (sha256, first 16 hex chars: a1b949af9e7bda1c and 02f244a9339a0cb6) and compare with the `base_prompt_sha` and `condition_briefing_sha` fields in any manifest. The seven `specs/*.txt` files hash to exactly the 7 `task_sha` values **[output: per-run manifests]** |
| the rendered system prompt varies only by workspace path | each run's `system_prompt_sha` is reproducible from the published template (with the run's recorded `workspace` path filled in) plus the published briefing **[output: per-run manifests]** |
| 29 of 1,116 runs went idle, one nudge each was enough | every run's `manifest.json` has a `finish_nudges` field; exactly 29 are above 0, none above 1, and all 29 end with status `finished` **[output: per-run manifests]** |
| nudged runs by model: gpt-5.5 20, claude-4.6-sonnet 4, grok-4.3 3, claude-4.8-opus 2 | group the manifests' `finish_nudges` > 0 by the manifest `model` field (provider-suffixed names); the other two models have zero, and the counts sum to the script-checked 29 in the Introduction row **[output: per-run manifests]** |

### II-B. The applications

| Number | Where |
|---|---|
| log explorer: 100,000+ rows, 200 rows per response | `specs/log-explorer-perf.txt` |

### II-D. Why the screenshot tool is passive

| Number | Where |
|---|---|
| the screenshot tool is Playwright driving headless Chromium, exposing only a render call | `guidelines/glossary.md` entry for **screenshot**; the tool takes one argument, `url`, which you can confirm in the published schema `agent-interface/tool-schemas/visual.json` or any exemplar trace |
| 21 runs stated an interaction limit in their reasoning | search the assistant text of `trace.jsonl` across `*/visual*/runs/*` for "can't click / interact / type / resize" or "screenshot tool can't" **[output: screenshot channel]** |
| one model (gemini-3.1-pro) installed a scriptable browser in three visual runs | install commands in `commands.json` of kanban-board/visual/16, message-board/visual/19, metrics-dashboard/visual/18 **[output: self-provisioned]** |

### II-E. Why execution does not trump the other configurations

| Number | Where |
|---|---|
| Puppeteer showed up in 3 of the 252 shell-only runs, never took a screenshot | the `commands.json` logs of kanban-board/delayed_verification runs 16 and 17 and kanban-labels-brownfield/execution run 17. No `.screenshot(` call anywhere **[output: shell-only runs]** |
| outside the two sight conditions the model is called with no visual input at all (vision = false) | the `vision` field in every run manifest: true in visual and visual_no_shell, false in the other six conditions |
| the command logs show no run computed facts about a screenshot with a script | no image-analysis tooling (PIL/pillow, jimp, sharp, pngjs, tesseract/OCR, pixelmatch, canvas, image-size, opencv, ImageMagick) appears in any recorded command across the 450 execution, delayed_verification, visual, and behavioral logs **[output: self-provisioned]** |

### II-G. Controlled test environment

| Number | Where |
|---|---|
| temperature 0.0, top_p 1.0 where the provider allows | `decoding` and `decoding_overridden` fields in the manifests. Three models did not honour the request: both Opus models fell back to provider defaults and gpt-5.5 ran at temperature 1.0. Each model used one setting across all 186 of its runs |

### II-H. Analysis rules (tool non-use)

| Number | Where |
|---|---|
| the three Claude models used every granted tool in all 462 of their tool-granted runs | `tool_uptake` in `freeze-20260720/merged_results.jsonl`; a run counts as non-use when the condition's checking tool has no invocation. Tool-granted = the seven conditions that grant any verification tool (all but no_verification): 154 per Claude model (32 static + 32 boot_check + 32 execution + 29 visual + 15 visual_no_shell + 10 delayed_verification + 4 behavioral) **[output: granted tools]** |
| grok-4.3 accounts for 55 of the 100 non-use runs | same field, grouped by model **[output: granted tools]** |
| the linter went unused in 23% of static runs, screenshots in 27% of visual runs | same field, grouped by condition (44 of 192 and 47 of 174) **[output: granted tools]** |

### II-J. Grading mechanism (intra-rater re-grade)

The re-grade data lives under `regrade/` (protocol: `REGRADE_RUNBOOK.md`,
written before the sample was drawn). The agreement numbers are computed by
`python3 regrade/analyse.py` from fixed inputs — the 112 second-pass cards
(`regrade/R*/card.json`) against the first-pass record
(`freeze-20260720/visual_items.jsonl`) — and written to
`regrade/agreement.csv`.

| Number | Where |
|---|---|
| per-item exact agreement 98.8% (589 of 596), weighted kappa 0.973, ICC(A,1) 0.997, mean absolute difference 0.52 points | pooled block of the analyse.py report; per-run columns in `regrade/agreement.csv` |
| launched-only split: 98.7% exact agreement, kappa 0.940, ICC 0.991 | launched block of the same report (105 runs, 552 item comparisons) |
| the two passes agreed on the survival call for all 112 runs; no run moved between zero and non-zero | `survived_first` / `survived_regrade` columns of `regrade/agreement.csv` |
| every item-level disagreement is between adjacent categories (pass/partial or fail/partial) | compare `regrade/R*/card.json` items with `visual_items.jsonl`: 7 disagreements, none pass-to-fail |
| 10 percent sample: 112 runs, stratified proportionally, 18 runs excluded from the frame, runs that never launched kept | `regrade/_sealed/sample.csv` (draw seed 20260812 in `regrade/draw_sample.py`), `regrade/exclusions.csv` (18 rows), `REGRADE_RUNBOOK.md` |
| four-week washout: grading closed July 15, re-grading ran August 16-19, 2026 | card mtimes / `REGRADE_RUNBOOK.md` ("not before 12 Aug"), `regrade/SESSIONS.txt` |
| blinding sentence: procedural blinding held — the mechanically blinded re-grade reproduced first-pass scores at 98.8% with every survival call unchanged | same sources; the opaque staging and path redaction are `regrade/stage.py` and `regrade/serve.py` |

### II-L. Whole application survival

| Number | Where |
|---|---|
| architectural fidelity is constant within every application; no build in any condition substituted the mandated stack | `fidelity_score` in run-summary: every run of the four realtime applications scores 1.0, and every run of calendar-week-view, metrics-dashboard, and log-explorer-perf scores 0.75 in every condition (their specs have no realtime requirement, so the scan's two SSE points - a server sending `text/event-stream` and a client using `EventSource` - cannot be earned; 6 of 8 points = 0.75 is their ceiling; see `static_fidelity()` in `grader/automatic_probes.py`). Group by task and condition: the value never varies |

## III. Hypotheses

| Number | Where |
|---|---|
| the six pre-registered hypotheses and their arms | `paper/stats-plan.md`; the tested form of each appears in stats, blocks P1 to P6 |
| P1 is tested on the three API tasks only | stats, P1 block header (n=168, message-board + kanban-board + seat-booking) |
| six hypotheses fixed in advance, one test each | `paper/stats-plan.md`, written before the analysis |
| the shell costs nearly three times as much as the boot probe | tables, section 8: 615,296 / 213,878 = 2.88; the S1 row in IV-B carries the effect side of the same contrast, and the Abstract row states the same ratio inverted (boot probe = 35% of a full shell) |

## IV. Results

### IV-A More verification, better outcomes

| Number | Where |
|---|---|
| survival 86.5 / 84.4 / 99.5 / 99.0 / 99.4 | run-summary counts: 166/192, 162/192, 191/192, 190/192, 173/174 (tables section 1 prints the truncated integers) **[output: census and survival]** |
| 66 launch failures in total | run-summary: 1,116 rows minus 1,050 that survive **[output: census and survival]** |
| 56 of the 66 from no_verification and static | count in run-summary (26 + 30) **[output: census and survival]** |
| corrupted source: 35 backend cases plus all 10 frontend cases | `genuine-boot-failures.csv` has 35 rows with verdict "genuine: source syntax defect"; `frontend-launch-audit.csv` holds 27 audited rows, of which the 10 with `status` = LAUNCH-FAILED are the never-rendering frontends (the other statuses are RENDERS-BROKEN and CARD-CORRECTED); each of those 10 `evidence` notes records a parse error in a frontend `main.js` **[output: failure anatomy]** |
| half the never-rendering frontends came from static | 5 of the 10 LAUNCH-FAILED rows in `frontend-launch-audit.csv` are static-condition runs (the rest: 2 no_verification, 1 each boot_check, visual, behavioral) **[output: failure anatomy]** |
| functional 81.9 / 78.3 / 91.7 / 94.2 / 92.6 | tables, section 2, "API tasks pooled" line |
| Table II, all of it (effects, intervals, p-values) | stats, blocks P1 to P6, printed exactly |
| **Table IV** (mixed-effects cross-check: estimates, SEs, CIs, two-sided p) and the claim that it agrees with every primary contrast | `paper/stats-mixed-effects.txt`, printed exactly (the two p-values printed as 0.0000 appear as <.0001 in the table); regenerate with `python3 paper/stats_mixed_effects.py` (needs the statsmodels library; every other analysis script is standard-library only) |
| P1 positive in five of six models | stats, P1 per-model line (the sixth is +0.0) |
| P2: gemini +50 survival points, gpt-5.5 +20, rest at ceiling | stats, P2 per-model line (+0.5 and +0.2 on a 0-1 scale) |
| linter: -3.6 functional, -2 points survival | stats, S4a and S4b |
| human score on the two visual tasks: 72.8 / 72.6 / 89.5 / 89.2 / 96.1 | tables, section 3: average the calendar and dashboard rows **[output: score ladders]** |
| ten of the twelve functional points arrive with the boot probe | tables, section 2: 91.7 − 81.9 = 9.8 of the 12.3 in stats P1 |
| pass rates on the heaviest probes: 92.0 shell / 91.1 boot probe / 89.1 blind | `freeze-20260720/automatic_probes_results.jsonl`. Restrict to runs with `boot_ok` true, keep the probes the grader gives a weight of 3 or 4, and take the weight-weighted pass rate. Shell means execution, visual, visual_no_shell and delayed_verification; blind means no_verification and static. The eleven probes are all_or_nothing, concurrent_double_book, confirm_idempotent, hold_blocks_others, move_card, ordering_integrity_stress, persistence_restart, reorder_within_column, sse_broadcast, sse_mutation_broadcast, sse_transition_broadcast **[output: heaviest probes]** |
| the same rates by condition: execution 93.6, visual 91.7, boot_check 91.1, static 90.4, delayed 89.9, no_verification 87.9, behavioral 83.7 | same computation, not pooled into the three groups **[output: heaviest probes]** |

### IV-B The boot probe

| Number | Where |
|---|---|
| 191 of 192 booted; 214k vs 615k tokens | tables, sections 1 and 8 |
| recovered nearly all the launch failures seen with no tools | run-summary: 26 of 192 no_verification runs fail the whole-app launch definition against 1 of 192 boot_check runs; tables, section 1 **[output: census and survival]** |
| within 2.5 points of execution on the easy and medium tasks | tables, section 2, message-board / kanban-board / seat-booking rows |
| dashboard 82.5 vs 92.0; log explorer 84.8 vs 93.8 | tables, section 3 |
| S1: +2.41, interval -0.38 to +5.21; 2.9x token cost | stats, S1; tables section 8 (615,296 / 213,878 = 2.88) |
| the highest ratio of artifact quality to token usage | tables: functional 91.7 (section 2) over the lowest median tokens of all eight conditions (213,878, section 8) = 429 points per million tokens; the core-five ratios are 313 / 284 / 429 / 153 / 137, and no other condition can pass 267 even with a perfect score at its section 8 median |

### IV-C Cost and variance

| Number | Where |
|---|---|
| medians 262k / 276k / 214k / 615k / 674k / 659k / 1,199k / 375k | tables, section 8 |
| 2.35x the baseline; screenshots about a tenth over the shell; delayed about double | divide the section 8 medians |
| **Table VI**, median cost spread by condition: 81k / 77k / 47k / 149k / 188k / 408k | tables, section 9. Each value is the median, across that condition's model-and-task combinations, of the standard deviation of the four or five repeat runs in a combination |
| 42 combinations per core condition, 12 for delayed_verification | six models times seven applications; delayed_verification ran on two applications; the per-cell run counts are printed in stats, Appendix F |
| Table III (S1 to S5) | stats, secondary blocks, printed exactly |
| the boot probe is the only configuration cheaper than building blind | tables, section 8: 213,878 against 261,602 |
| failed blind builds cost less than successful ones (182k vs 263k) | median `total_tokens_used.total_tokens` in the manifests, split by `runs_via_declared_path` **[output: token accounting]** |
| among builds that started: 17 vs 19 steps, 13.5k vs 16.8k output, 195k vs 247k input | `steps` and `total_tokens_used` in the manifests, boot_check against no_verification, survivors only; the output pair is the completion-token medians (13,513 vs 16,760) and the script checks all three pairs **[output: token accounting]** |
| comparing only builds that started, the boot probe still costs about 49 thousand tokens less than working blind | median `total_tokens_used.total_tokens` among survivors: boot_check 213,878 against no_verification 263,406; 263k − 214k = 49k **[output: token accounting]** |
| after the shell unlocked, 45 of the 60 delayed_verification runs edited their code before finishing again | `verification_unlocked_at_step` in each manifest, plus the tool calls after that step in `commands.json` **[output: delayed_verification: discovery]** |
| delayed runs that finished unchanged scored about seven functional points higher (97.1 vs 90.1) | join the same edit flags with `functional_pct` in run-summary **[output: delayed_verification: discovery]** |

### IV-D The sight boundary

| Number | Where |
|---|---|
| **Table VII** (calendar and dashboard rows) | tables, section 3 |
| the four gaps +10.9, +4.3, +2.9, +5.7 | tables, section 3: subtract the execution column from the visual and visual_no_shell columns **[output: score ladders]** |
| P4: +6.88, interval +0.83 to +13.41, p .0413, Holm .0826 | stats, P4 |
| S2: +4.98, interval -1.42 to +11.75 | stats, S2 |
| sight without a shell matches sight with one (97.7 vs 94.9 on the dashboard) | tables, section 3, metrics-dashboard row |
| gaps +10.9 calendar, +2.9 dashboard, -2.1 log explorer | tables, section 3 **[output: score ladders]** |
| **Table VIII**, per-model gaps and screenshot counts | stats, S6 blocks (also tables, section 6) |
| grok's shell baseline 48 to 56; sonnet's 74 | tables, section 6 (execution = 48.2 and 55.8; 74.1) |

### IV-E Brownfield

| Number | Where |
|---|---|
| gaps 10.0 and 14.0 (brownfield) vs 10.6 and 11.8 (greenfield) | tables, section 5 |
| difference-in-differences -0.67, interval -13.67 to +12.67 | stats, P5 |
| 140 of 144 extended; median 3 of 6 files touched; 4 rewrites (3 static, 1 visual) | `runs/batch-20260613/extend-vs-rewrite.csv` **[output: brownfield companion]** |

### IV-F Performance budgets

| Number | Where |
|---|---|
| human 78.5 / 80.5 / 84.8 / 93.8 / 91.7 / 91.2 | tables, section 3, log-explorer-perf row |
| the visual venues' figures quoted for contrast (97.3 / 86.4, 94.9 / 92.0) | tables, section 3, calendar and dashboard rows |
| 13 of the 66 failures on this task, 11 of the 13 blind or linter | count in run-summary **[output: census and survival]** |
| P6: +15.33, p .0225, Holm .0675; gemini +100 | stats, P6 and its per-model line |
| **Table IX**, per-model gaps and launch counts on the log explorer | run-summary, log-explorer-perf rows: mean `human_pct_current` per model for execution and no_verification, and `runs_via_declared_path` for the launch counts. None of gemini's five blind builds started **[output: log explorer]** |
| S3: -2.17, interval -12.50 to +7.33 | stats, S3 |

### IV-G Self-authored tests

| Number | Where |
|---|---|
| 24 runs, 83% survival; 71.2 vs 87.3 (same task) vs 94.2 (pooled) | tables, sections 1 and 2 |
| S5: -16.07, p .0425; negative for five of six models | stats, S5 and its per-model line |
| the arm stopped early rather than running out: 369k vs 810k tokens, 22 vs 49 steps, similar output | `total_tokens_used` and `steps` in the seat-booking manifests, behavioral against execution **[output: token accounting]** |
| "while writing a similar amount of code" | median completion tokens in the same seat-booking manifests: behavioral 22,019 against execution 21,800 **[output: token accounting]** |
| no run was stopped by a budget | every manifest has status `finished`; `max_total_tokens` varies by run and only 5 runs reach 90% of their own cap **[output: token accounting]** |

## V. The Defect Catalog

| Number | Where |
|---|---|
| the same Vite mistake in 52 runs: 20 proxy cases (mostly claude-4.8-opus) plus 32 launch-folder cases (mostly claude-4.6-opus) | `grading-hazards.csv` in the repository root: 52 rows, 20 class A, 32 class B **[output: failure anatomy]** |
| the clamp specimen scored 7.1 percent with zero of eight rubric items | run-summary, calendar-week-view / no_verification / run 29; the fixed version is visual_no_shell / run 28 at 96.4 |
| the linted syntax error: the linter was invoked once and failed with "Missing script" | `commands.json` and `trace.jsonl` for calendar-week-view / static / run 26, steps 12 and 15 |

## VI. Configuration integrity and model signatures

### VI-A Declared-launch integrity

| Number | Where |
|---|---|
| 45 of 1,116 wiring defects (4%), highest under boot_check | count bad `wiring_status` values in run-summary **[output: configuration defects]**; rates in tables section 7 |
| datadir bug in 169 builds (15%) | run-summary has 167 rows with `datadir_status` WILL-FAIL or LATENT, plus 2 confirmed by hand in `datadir-unknown-resolutions.csv` **[output: configuration defects]** |
| about 21-26% blind and static, about 6% boot probe, 11-13% shell | tables, section 7, by condition |
| only the data-directory scanner produced undecided cases | `wiring_report.csv` has no UNKNOWN status; `datadir_report.csv` has 5, resolved in `datadir-unknown-resolutions.csv` (2 confirmed bugs, 3 not) **[output: wiring defects]** |
| claude-4.6-opus accounts for 16 of the 22 proxy-not-loaded cases | `wiring_report.csv`, `PROXY_NOT_LOADED` rows grouped by model **[output: wiring defects]** |
| claude-4.8-opus accounts for 14 of the 16 api.js collisions | `wiring_report.csv`, `API_JS_COLLISION` rows grouped by model **[output: wiring defects]** |

### VI-B Model signatures

| Number | Where |
|---|---|
| by model: 41% sonnet, 24% 4.8-opus, 3% gemini, one single grok build | tables, section 7 by model; the grok count **[output: configuration defects]** |
| **Table X**, the Cramér's V values | work them out from `runs/batch-20260613/architecture-report.csv`; the script does (V = sqrt(chi-squared / (n * (k - 1)))) **[output: architecture signatures]** |
| gpt-5.5 lays out a src tree in 77% of runs and starts its frontend bare in 94% | architecture-report, `dir_style` and `vite_invocation` columns (144/186 and 174/186) **[output: architecture signatures]** |
| grok-4.3 mixes manifest layouts in 82% of runs | architecture-report, `manifest_layout` column (152/186) **[output: architecture signatures]** |
| grok-4.3 uses the positional launch in 75% of runs yet produced no wiring defects | architecture-report `vite_invocation` (140/186) against `wiring_report.csv` (0 defects) **[output: structural idioms]** |
| code volume flat, about 715 to 800 mean lines | average `total_loc` per core condition: 715.5 (visual) up to 800.2 (static) **[output: architecture signatures]** |
| tool lift runs from +0.0 to +36.7 | `runs/batch-20260613/model-profiles.csv`, `tool_lift` column |

## VII. Limitations

| Number | Where |
|---|---|
| 4 to 5 replicates per cell, six models | group run-summary rows by task, condition, and model |
| single grader: the re-grade reproduced item verdicts at 98.8 percent (weighted kappa 0.97 pooled, 0.94 on launched runs) and agreed on every survival call | the II-J re-grade rows above (`regrade/agreement.csv`, `regrade/analyse.py`) |
| the screenshot channel: 264 runs, 214 took a screenshot, 1,326 calls to 260 distinct URLs | `trace.jsonl` across `*/visual*/runs/*`, counting `screenshot` tool calls and their `url` argument **[output: screenshot channel]** |
| 512 of those calls (39%) went beyond the application's own root | same, counting URLs with a path, query, or fragment after the origin **[output: screenshot channel]** |
| 110 runs used at least one such URL; 67 built a purpose-made page to photograph | same, grouped by run; harness pages match names such as preview, test, demo, seed, viewport **[output: screenshot channel]** |
| static-preview-hold.html and static-preview-booked.html | seat-booking/visual/runs/4 `trace.jsonl` |
| a javascript: URL seeding four events | calendar-week-view/visual_no_shell/runs/22 `trace.jsonl` |
| gemini-3.1-pro installed a scriptable browser in three visual runs; no other model installed verification tooling anywhere | install commands in `commands.json` of kanban-board/visual/16, message-board/visual/19, metrics-dashboard/visual/18; a sweep of all 426 shell-holding logs finds no other tooling installed **[output: self-provisioned]** |

## VIII. Conclusion

| Number | Where |
|---|---|
| one build in seven fails blind; one in 192 under the boot probe | tables, section 1, pooled line |
| weakest model gained 37 points from a shell, strongest gained nothing | `model-profiles.csv` (36.7 and 0.0); same numbers in the stats P1 per-model line |
| full shell multiplies cost by 2.35 times | tables, section 8: 615,296 / 261,602 |

## If you want to rebuild the two source files themselves

The tables and stats files are outputs too. The README section "Reproducing
the results" walks through regenerating them from the raw per-run data: the
verification chain rebuilds `run-summary.csv` byte for byte, and
`stats_analysis.py` reruns every test from a fixed seed. Numbers the paper
cites from earlier work (the 90-run observational study) belong to
arXiv:2607.02436, not to this archive.
