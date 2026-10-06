# Changelog

All notable changes to this dataset release. Dataset snapshots are sealed,
SHA256-checksummed folders (`freeze-YYYYMMDD/`); a snapshot is never modified
after sealing, and a superseded snapshot is retained for provenance.

## [1.3.2] — 2026-10-06

No graded data changed, no sealed snapshot was modified, and the dataset of
record remains freeze-20260720/. Added Requirements and Contribution guidelines
sections to README.md. Fixed the obfuscated llm endpoint in manifest.json.

Archived at Zenodo: concept (all-versions) DOI [10.5281/zenodo.21961590](https://doi.org/10.5281/zenodo.21961590);
this release's version DOI is [10.5281/zenodo.23197787](https://doi.org/10.5281/zenodo.23197787).

## [1.3.1] — 2026-08-24

Verification and documentation only, no graded data changed, no sealed snapshot was modified, and the dataset of record remains freeze-20260720/. verify_paper_claims.py gains four checks, the boot probe's output-token medians among started builds (13,513 vs 16,760), its ~49k total-token saving over building blind (213,878 vs 263,406), the behavioral arm's near-identical code output on seat-booking (22,019 vs 21,800 completion tokens), and a sweep confirming no shell-holding run invoked image-analysis tooling (450 command logs, zero hits). verify-output-v1.3.1.txt supersedes v1.2.0's output. CLAIMS.md updated to match the submitted manuscript: mixed-effects results now in-paper as Table IV (later tables shift by one), the cost multiplier stated as 2.35 throughout, and new provenance rows for the intra-rater re-grade and the vision=false / self-built-sight claims.

## [1.3.0] - 2026-08-20

Intra-rater re-grade release. No graded data changed, no sealed snapshot was
modified, and no published score was revised; the dataset of record remains
`freeze-20260720/`. Archived at Zenodo: concept (all-versions) DOI
[10.5281/zenodo.21961590](https://doi.org/10.5281/zenodo.21961590); this
release's version DOI is
[10.5281/zenodo.22036687](https://doi.org/10.5281/zenodo.22036687).

- The 10% intra-rater check specified in `REGRADE_RUNBOOK.md` was carried out.
  A 112-run sample (seed 20260812, stratified proportionally across task x
  condition, drawn from the 1,098-run frame after the 18 pre-registered
  exclusions) was staged under opaque identifiers with blanked cards and
  re-graded across four sessions, 16 to 19 August 2026, four weeks after
  grading closed. On the 105 launched runs the second pass reproduced the
  first on 98.7% of individual rubric items (545 of 552), with linearly
  weighted kappa 0.940, ICC(A,1) 0.991 on `human_pct`, mean absolute
  difference 0.56 points, and complete agreement on the whole-application
  survival call. Launched and non-launched runs are reported separately
  because non-launched cards are all-fail by rule and agreement on them is
  close to automatic.
- `verify-output-v1.2.0.txt` is unchanged and remains current: no input to
  `verify_paper_claims.py` was altered by this release.
- Added `regrade/analyse.py` (the step 5 analysis), `regrade/agreement.csv`
  (per-run output), `regrade/regrade-report.md`, `regrade/SESSIONS.txt`,
  `regrade/SWAPS.csv`, `regrade/ENVIRONMENT.txt`, the 112 scored cards
  `regrade/R001`-`R112`, and `regrade/_sealed/` holding `sample.csv` and
  `MAPPING.csv`. The last was sealed during grading and is published now so
  that the draw can be reproduced from the recorded seed.

## [1.2.1] - 2026-08-20

*(Repository-only patch. Tagged in this changelog but not archived as a
separate Zenodo version; the archive of record remains 1.2.0 at
[10.5281/zenodo.21961591](https://doi.org/10.5281/zenodo.21961591). No data,
no result and no sealed snapshot changed.)*

- `regrade/status.py`: corrected the graded-count test. It counted a card as
  graded if any field in it was non-empty, but a blanked card still carries
  its criteria, weights and task name, so every staged card read as complete
  and the tool reported the whole sample graded from the moment staging
  finished. It now tests only the fields `stage.py` blanks, and reports
  untouched, partly scored and complete separately.
- `regrade/serve.py`: added `--cmd`, which runs a recorded launch
  accommodation in the app directory instead of an npm script, with the same
  path, task and condition redaction and the same logging.
- `README.md`: the article title now matches `CITATION.cff` and the Zenodo
  record. The two had diverged.
- `.gitignore`: whitelisted the re-grade protocol records so they ship with
  the re-grade release.

## [1.2.0] - 2026-08-16

Correction and cross-check release. No graded data changed and no sealed
snapshot was modified; the dataset of record remains `freeze-20260720/`.
Archived at Zenodo: concept (all-versions) DOI
[10.5281/zenodo.21961590](https://doi.org/10.5281/zenodo.21961590), which resolves to the latest
release; this release's version DOI is
[10.5281/zenodo.21961591](https://doi.org/10.5281/zenodo.21961591).

- Added the analysis plan's named mixed-effects cross-check
  (`paper/stats_mixed_effects.py`; requires the statsmodels library, the one
  exception to the standard-library-only rule) and its complete output
  (`paper/stats-mixed-effects.txt`). It agrees with the permutation results
  on all six primary contrasts in direction and magnitude.
- Citation metadata corrected: `CITATION.cff` and `.zenodo.json` now carry
  the article's current title, name `freeze-20260720/` as the dataset of
  record, and count all three sealed snapshots.
- `CLAIMS.md` corrections: the Claude tool-uptake claim corrected from 288 to
  462 tool-granted runs, with the definition spelled out; survival rates
  restated to one decimal from raw counts, matching the paper; a
  median-convention note added (the sealed tables print the middle run's
  value; medians quoted in the paper's text are standard medians); rows that
  verify against the full request-response traces now say the complete
  traces are available on request (one exemplar per condition is published).
- `verify_paper_claims.py`: the median helper now computes the standard
  median (the average of the two middle values for an even count), matching
  the paper's quoted numbers; the Claude tool-uptake assertion corrected to
  462. A per-model nudge-breakdown check (20/4/3/2) was added.
  Path handling in the manifest, command-log, and trace scans was made
  separator-proof, so the script now runs identically under Windows and
  POSIX Python (it previously crashed on Windows).
- Added `verify-output-v1.2.0.txt`: the complete release-time transcript of
  `verify_paper_claims.py --with-traces` on the sealed dataset (88 checks,
  0 discrepancies), for readers who inspect rather than run.
- `.gitignore`: removed the unused polish-comparison entries and stale
  comments, removed whitelist entries for files that do not exist at those
  paths, and whitelisted the mixed-effects cross-check files.
- Release composition: the complete per-run request-response traces
  (`trace.jsonl`, roughly 5 GB) are published as a supplementary archive in
  the Zenodo record rather than in the git tree; `console.log` files are no
  longer part of the release (retained locally). The archive is
  `traces-batch-20260613.tar.gz` (1,116 files; sha256
  `2c47fa647a7e55218a0ffd42dda04e0bc13a216fd1561235dfab3ad1f6f5c4df`);
  unpacking it from a clone's root restores the per-run
  `runs/.../smoke/logs/trace.jsonl` paths.
  `verify_paper_claims.py --with-traces` verifies the trace-derived claims
  once the archive is unpacked over a clone.
- Privacy correction: the `base_url` field in every per-run `manifest.json`
  recorded the internal model-gateway host through which all six models were
  served. All 1,116 manifests now record the placeholder
  `https://<internal-gateway>/v1`; the local `console.log` files, which are
  not part of the release, were normalised to match. Nothing hashes or
  verifies against `base_url`, so the run-identity chain, the sealed
  snapshots, and `verify-output-v1.2.0.txt` are unaffected. The
  pre-publication scrub that gates each release gained matching block
  patterns so that the omission cannot recur.
- Repository re-initialised 2026-08-16. Earlier commit history is not carried
  forward: the gateway host above was present in every manifest committed
  since 1.0.0 and would have stayed readable in the published history. The
  1.0.0-1.0.2 entries below document those releases but are not retrievable
  as git tags here. The Zenodo record archiving them was withdrawn for the
  same reason, so the DOIs cited in those entries (10.5281/zenodo.21404371
  and 10.5281/zenodo.21404372) no longer resolve; the archive of record is
  the DOI in the README badge.

## [1.0.2] - 2026-07-20

*(Tagged in this changelog but not released to Zenodo as a separate version;
its content ships with 1.2.0.)*

New dataset-of-record snapshot `freeze-20260720/`, superseding `freeze-20260716/`.

- **No graded data changed.** Every data file in `freeze-20260720/` is
  byte-identical to `freeze-20260716/`; the two `SHA256SUMS` match on every line
  except `freeze-tables.txt`.
- The sole difference is an added **section 9 ("TOKEN SPREAD by condition")** in
  `freeze-tables.txt`, reporting per-condition run-to-run token variability
  (median within-cell sample standard deviation) used in the cost-and-variance
  analysis. It is derived from the per-run token totals recorded in each run's
  manifest; no graded score changed.
- `freeze-20260716/` and `freeze-20260703/` are retained for provenance.

## [1.0.1] - 2026-07-16

Citation-metadata release. No dataset, code, or result changed; the dataset of
record remains the sealed `freeze-20260716/`.

- Recorded the Zenodo archive DOI. `CITATION.cff` now carries the concept
  (all-versions) DOI [10.5281/zenodo.21404371](https://doi.org/10.5281/zenodo.21404371)
  as an active `doi:` field (it was present but commented out in 1.0.0), and
  `README.md` gained a DOI badge and a citation pointer.
- This release's own version DOI is assigned by Zenodo when the GitHub release
  is published (a new version DOI under the same concept DOI above).

## [1.0.0] - 2026-07-16

Initial public release. Archived at Zenodo: concept DOI
[10.5281/zenodo.21404371](https://doi.org/10.5281/zenodo.21404371) (resolves to
the latest version); this release's version DOI is
[10.5281/zenodo.21404372](https://doi.org/10.5281/zenodo.21404372).

- Dataset of record: `freeze-20260716/` (1,116 runs; 6 models x 7
  applications x 5-8 tool configurations; all rubric cards hand-graded by a
  single condition-blind grader; zero machine-filled cards).
- Includes the superseded snapshot `freeze-20260703/` for provenance. The
  differences (14 run-summary rows) are fully accounted for by three
  audited, pre-publication refinements, each recorded in the dataset:
  1. Two mis-graded rubric cards corrected (all-fail -> all-pass;
     corroborated by functional scores of 100).
  2. Survival definition amended to cover the application as a whole:
     10 hand-audited runs whose backend boots but whose frontend is
     unrenderable through any declared path are counted as launch failures
     (adjudication record: `runs/batch-20260613/frontend-launch-audit.csv`,
     also sealed inside the freeze).
  3. Two grader-attribution fixes (cards that were hand-graded but carried
     a stray machine grader name).
- Statistics: pre-registered plan (`paper/stats-plan.md`), committed
  analysis code (`paper/stats_analysis.py`, seed 20260703, 10,000
  permutations, 5,000 bootstrap resamples), and complete output
  (`paper/stats-results.txt`) computed on the dataset of record.
- Grading instrument: `grader/automatic_probes.py` + frozen rubric cards.
- Verification chain: `check_probe_completeness.py`,
  `verify_pre_merge_results.py`, `merge_results.py` (regenerates
  `run-summary.csv` byte-for-byte from the published inputs),
  `verify_post_merge_results.py` (independent re-check, including a
  card-only re-derivation of the survival column).
- Agent interface exports: byte-exact base prompt and environment briefing
  (hash-verified against every run manifest), per-condition tool schemas,
  and one full example trace per condition.
