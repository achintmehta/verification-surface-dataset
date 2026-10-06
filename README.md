[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21961590.svg)](https://doi.org/10.5281/zenodo.21961590)
# Verification-Surface Dataset: 1,116 Controlled Web-Application Builds by Six LLMs


## Description

This repo holds the data and the grading and analysis code behind the paper
**"The reach of a verification tool decides its value: A controlled study
of verification surface, artifact quality, and cost in AI coding agents"**
(A. Mehta, under review, 2026).

## The dataset of record

**`freeze-20260720/`** is the sealed snapshot behind every number in the
paper. To check that nothing has changed:

```bash
cd freeze-20260720 && sha256sum -c SHA256SUMS
```

The two older folders, `freeze-20260716/` and `freeze-20260703/`, are earlier
snapshots kept for the record. `freeze-20260720/` differs from
`freeze-20260716/` in exactly one file: `freeze-tables.txt` gained a
token-spread table (section 9) used in the cost analysis. Every data file is
byte-identical, so the two `SHA256SUMS` agree on every other line.
`freeze-20260703/` differs from `freeze-20260716/` in 14 run-summary rows;
`CHANGELOG.md` and `runs/batch-20260613/frontend-launch-audit.csv` account
for all 14.

## Dataset and code information

| path | contents |
|---|---|
| `runs/batch-20260613/<task>/<condition>/runs/<n>/app/` | one built application, exactly as the model shipped it |
| `.../runs/<n>/smoke/logs/` | `manifest.json` (model, condition, input hashes, token totals), `commands.json` (every tool call), `visual-scores.json` (the human's filled scorecard) |
| `runs/batch-20260613/*.csv, *.jsonl` | batch-level tables: `run-summary.csv` (one analysis-ready row per run), `merged_results.jsonl` (the same plus full probe detail), `visual_items.jsonl` (per-item human scores), scanner reports, audit files |
| `freeze-20260720/`, `freeze-20260716/`, `freeze-20260703/` | sealed snapshots with SHA256SUMS (20260720 is the dataset of record) |
| `specs/*.txt` | the seven task specifications. They never mention tools, and their hashes match every manifest |
| `specs/brownfield-starter/` | the starting codebase for the modification task |
| `agent-interface/` | the exact base prompt and environment briefing (their sha256 prefixes match every manifest), the tool schemas per condition, and one full example trace per condition. The author's local username in tool outputs (npm log paths and the like) is redacted to `user`; the traces are otherwise untouched |
| `grader/` | the grading instrument: `automatic_probes.py`, the probe catalog (`GRADER.md`), the row schema (`RESULTS-SCHEMA.md`), and the frozen rubric cards (`rubrics/`) |
| `paper/` | the analysis plan written before the analysis (`stats-plan.md`), the statistics code (`stats_analysis.py`), and its complete output (`stats-results.txt`), plus the mixed-effects cross-check (`stats_mixed_effects.py`) and its output (`stats-mixed-effects.txt`) |
| `guidelines/` | the grading protocol (`app-grading-guide.md`), terminology (`glossary.md`), and the defect notebook (`defect-specimens-batch-20260613.md`) |

What each machine-grade field means: `grader/RESULTS-SCHEMA.md`. Where every
column of the analysis table comes from: the docstring at the top of
`merge_results.py`.

One artifact of the serving infrastructure shows up in the run records: lines
reading `[System: Empty message content sanitised to satisfy protocol]` come
from the API gateway, not from the model or the harness. When a model
returned a turn with no text (a bare tool call), the gateway substituted that
fixed placeholder. It behaved identically for every model and condition.

**Checking a number from the paper?** [`CLAIMS.md`](CLAIMS.md) maps each one
to its file here. Most are printed in `freeze-20260720/freeze-tables.txt` or
`paper/stats-results.txt`, which you can read in the browser.
`verify_paper_claims.py` works out the rest from the data files.

## Requirements

- Python 3.10. The verification chain and the scripts that rebuild the analysis table use only the standard library.
- Statistics (paper/stats_mixed_effects.py): numpy, pandas and statsmodels.
- Figures: matplotlib and Pillow.
- Regrading applications from scratch: Node.js 22 with npm, Playwright with Chromium, and psutil.

## Contribution guidelines

This archive is the frozen dataset of record for the published study, so released files are not changed. Corrections are
published as new versions and listed in CHANGELOG.md. Please report problems or questions by email to the author
(achintmehta@gmail.com) or as an issue on the GitHub repository.

## Usage instructions

You need Python 3.10 or newer; the analysis scripts use only the standard
library. Re-grading apps also needs Linux, Node.js 22+, `curl`, and `ss`.

**1. Rebuild the analysis table from the published inputs.** The result is
byte-for-byte identical to the sealed `run-summary.csv`:

```bash
python3 check_probe_completeness.py     # every run has a machine grade: expect 1116/1116
python3 verify_pre_merge_results.py     # probe rows + rubric cards: expect 0 discrepancies
python3 merge_results.py                # the join; the only place cards become scores
python3 verify_post_merge_results.py    # independent re-check, including a card-only
                                        # re-derivation of the survival column: expect 0
diff runs/batch-20260613/run-summary.csv freeze-20260720/run-summary.csv   # expect empty
```

**2. Rerun the statistics.** Fixed seed 20260703, 10,000 permutations, 5,000
bootstrap resamples. The first output line names the dataset it read:

```bash
python3 paper/stats_analysis.py > stats-results-reproduced.txt
diff stats-results-reproduced.txt paper/stats-results.txt   # expect only the provenance path line
```

The plan in `paper/stats-plan.md` was written down before any p-value was
computed: one main test per hypothesis, Holm correction across the six, and
every run counted in the group it was assigned to, whatever happened after.

**3. Re-grade any app from scratch.** The probes are deliberately rough on
the app: eight simultaneous requests for one seat, kill and restart, ordering
under load.

```bash
cd grader
python3 automatic_probes.py ../runs/batch-20260613/<task>/<cond>/runs/<n> --install \
        --out /tmp/regrade.jsonl --csv /tmp/regrade.csv
```

Apps are graded as shipped. The grader never edits code, and the only help it
gives (installing declared dependencies, one retry after creating a missing
folder) is the same for every run and is written into the `notes` field. The
rules the human grader worked under are in `guidelines/app-grading-guide.md`.

**4. Check every number the paper quotes.** `CLAIMS.md` lists them one by
one:

```bash
python3 verify_paper_claims.py                   # expect: 0 discrepancies
python3 verify_paper_claims.py --skip-run-tree   # quick pass: tables only,
                                                 # skips the 1,368-file scans
python3 verify_paper_claims.py --with-traces     # additionally verifies the
                                                 # screenshot-channel claims; needs the
                                                 # Zenodo trace archive unpacked over the tree
```

## Key columns

- `functional_pct`: the machine score (API tasks only). A run that never
  boots scores 0 rather than being dropped. Empty for the tasks that have no
  probes.
- `human_pct_current`: the human score, for every task and every run. The
  grader could not see model or condition; items score pass 1, partial 0.5,
  fail 0, weighted.
- `runs_via_declared_path`: the survival column, for the app as a whole. True
  when the backend booted, or a human got the app running through a setting
  the app itself declares. The 10 hand-checked frontend launch failures
  (`frontend-launch-audit.csv`) count as failures. The post-merge verifier
  derives this column two independent ways and requires them to agree.
- Machine and human scores are never merged into one number. That is by
  design.

## The agent harness

The builds came from a small custom agent. The only thing that changes
between conditions is the list of tools it is handed. The agent's source code
is not in this archive, but everything it did is: the exact prompts, the tool
schemas per condition, one full example trace per condition
(`agent-interface/`), the complete tool-call log of every run
(`commands.json`), and the complete request-response trace of every run
(`trace.jsonl`, published as a supplementary archive in the Zenodo record,
roughly 5 GB; unpack it over a clone to restore the per-run paths). The harness
source code is provided with the article as Supplemental Data S1.

## Methodology

Six language models (claude-4.6-sonnet, claude-4.6-opus, claude-4.8-opus,
gpt-5.5, gemini-3.1-pro, grok-4.3) each built seven small web applications
over and over, under five to eight different tool setups, from no checking
tools at all up to a full shell plus screenshots. That comes to 1,116 builds.
Only the tool list changed between setups: the system prompt, the environment
briefing, and the task text were byte-for-byte the same in every run, and
every run's manifest records their hashes so you can check that yourself.
Every finished app was then graded exactly as the model shipped it. Automatic
probes tested the apps whose behavior can be checked over the API, and a
human scored every app against a fixed checklist, in shuffled order, without
knowing which model or tool setup had built it.

## License and citation

The code is MIT. The data and documentation are CC BY 4.0. See `LICENSE`,
including the note about the model-generated application code.

Cite using `CITATION.cff`, or the archive DOI
[10.5281/zenodo.21961590](https://doi.org/10.5281/zenodo.21961590), which
always points at the latest release.

Version history: `CHANGELOG.md`.
