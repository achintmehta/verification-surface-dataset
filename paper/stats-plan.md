# Statistical analysis plan — written down before computing anything

*Why this document exists: when you run statistics after seeing your data, it is
easy to fool yourself by testing many things and reporting the ones that look
good. The protection is to write down, in advance, exactly which comparisons
count, how they will be tested, and what "supported" means, and then never
change those choices. One honest caveat: we already saw the average scores
during grading, so this is not blind in the strictest sense. What we are
committing to before computing is every remaining choice: the tests, the
corrections, and the rules. After `stats_analysis.py` runs once, this plan is
frozen; anything we compute beyond it gets labeled "exploratory."*

## What data goes in

The sealed freeze snapshot (`freeze-20260703/run-summary.csv`, 1116 builds),
plus token counts read from each run's manifest. Four outcomes per build:

- **functional score**: the percentage of automated behavior probes passed
- **human interface score**: the percentage of rubric points a human grader awarded
- **survival**: did the app start through any path its own files declare (yes/no)
- **cost**: total tokens the build consumed (analyzed on a log scale, because
  token counts spread multiplicatively)

Every build counts, exactly as assigned. A build that never started keeps its
zero. A model that ignored a granted tool stays in its assigned group. (This is
the "intention-to-treat" principle: we measure what *granting* a tool does,
because that is the decision a system designer actually controls.)

## How each comparison is tested

**The main test, in plain words — with a worked example.** Suppose one model
built the kanban app 8 times: 4 runs with a shell (scores 96, 94, 98, 92,
average 95) and 4 with no tools (85, 88, 82, 89, average 86). The real
difference is +9 points. The skeptic's objection: "runs vary anyway — maybe the
shell did nothing and the shell group just got lucky draws." The test answers
that skeptic quantitatively: how big a difference could luck alone produce
here?

The key idea: if the shell truly did nothing, those 8 scores are just 8 scores
this model produces on this task, and the labels "shell" and "no-tools" are
meaningless stickers — you could peel them off and re-stick them anywhere
without changing anything real. That is exactly what shuffling does. Peel off
the 8 labels, deal them back out at random (4 get "shell", 4 get "no-tools"),
and compute the group difference in that pretend world where the label is
arbitrary. One shuffle might give shell = {85, 94, 82, 92} vs no-tools =
{96, 88, 98, 89}, difference −4.5. Another gives +2.3. Another −7.1. Do this
10,000 times and you have built, from your own data, a picture of what
differences pure luck produces when the tool genuinely does not matter.

That picture is the yardstick. Hold the real difference (+9) against it: if
3,000 of the shuffles produced +9 or more, then +9 is the kind of thing luck
does routinely — no evidence. If only 40 of 10,000 shuffles reached +9, then
either the shell really helped, or you witnessed a 1-in-250 coincidence. That
fraction — 40/10,000 = 0.004 — IS the p-value. Nothing more mysterious than
"how often does luck fake my result." The method's charm is that it assumes
nothing: no bell curves, no formulas about how scores "should" distribute; the
yardstick is manufactured from the actual scores at hand. It works identically
for yes/no outcomes like survival. (Formally: a permutation test.)

**Is this an established method?** Yes — one of the oldest in modern
statistics: the permutation test (also called a randomization test, or an exact
test when every possible shuffle is enumerated rather than sampled). It goes
back to Ronald Fisher in the 1930s — the famous "lady tasting tea" experiment
is exactly this logic — and was formalized by Pitman shortly after. A useful
historical irony: Fisher regarded the familiar t-test as a computational
*approximation to* the permutation test, tolerable only because in 1935 nobody
could do ten thousand shuffles by hand. Computers removed that constraint, so
the original method came back. Today it is thoroughly mainstream and standard
in this study's own neighborhood: paired permutation tests are the usual way
NLP/ML papers compare two systems on a shared test set, they are the backbone
of neuroimaging statistics, and they are routine in genomics and industry A/B
testing. The stratified variant used here (shuffling only within blocks) is the
standard adaptation for blocked designs, and the bootstrap used for the
confidence ranges is Efron (1979), among the most-cited statistical methods
ever. For the paper: cite Fisher (1935, The Design of Experiments), Pitman
(1937), Efron (1979), and, as a field-local anchor for system comparisons,
Yeh (2000) or Dror et al. (2018). A reviewer should find this choice *more*
careful than off-the-shelf t-tests for this data: bounded scores with ceiling
effects, binary survival outcomes, and six-model blocks violate bell-curve
assumptions in ways the shuffle simply does not care about.

**Why we only shuffle within model-and-task groups.** Imagine pooling
everything and shuffling globally: a grok calendar score could get dealt into
the same comparison as an opus message-board score. Shuffled differences would
then be inflated by model quality and task difficulty — things we know differ —
and the yardstick would measure the wrong kind of luck. So the rule: labels may
only be re-dealt among runs identical in every respect except the treatment —
same model, same task, differing only in which tools were granted. Like testing
whether a training program makes runners faster by shuffling within age groups,
never letting a 20-year-old's time stand in for a 70-year-old's. The overall
statistic combines the within-group comparisons, so the only thing the shuffle
ever breaks is the tool assignment — precisely the thing on trial. (Formally:
stratification; the strata are model × task.)

**The size of the effect, with honest uncertainty.** A p-value only says
"probably not luck." We also report how *big* each difference is (in score
points) and a 95% confidence range for it, computed by resampling: rebuild the
dataset thousands of times by drawing runs at random with replacement from
within each model-task-condition cell, and see how much the difference wobbles.
(Formally: a stratified bootstrap, 5,000 rounds.)

**Two cross-checks, reported alongside.** First, a very simple test: compute
each model's own difference, and ask whether it is plausible that six coins
would land this lopsidedly (a sign test over the six per-model differences).
Second, if the statsmodels library is available, a standard mixed-effects
regression. If the methods disagree, we say so rather than picking the
friendliest.

## The six comparisons that count (one per hypothesis)

Because testing many things inflates the chance of a fluke "discovery," only
six comparisons are primary, and their p-values are corrected as a family (the
Holm method, which makes each result pass a stricter bar the more things you
test). "Supported" means: corrected p below 0.05 AND the confidence range
excludes zero in the predicted direction.

| # | plain-language question | outcome | where | prediction |
|---|---|---|---|---|
| P1 | Does a full shell produce better-behaving apps than no tools? | functional | the three API-tested apps | shell higher |
| P2 | Does the one-call boot probe save apps that would otherwise never start? | survival | all apps | probe higher |
| P3 | Does a shell cost more tokens than building blind? | log tokens | all apps | shell higher |
| P4 | Do screenshots improve the human-judged interface beyond a shell? | human score | the two visual apps | screenshots higher |
| P5 | Do tools matter MORE when modifying unfamiliar code than when writing fresh code? | functional | the kanban pair | tested both ways |
| P6 | On the performance task, does a shell beat building blind? | human score | log-explorer | shell higher |

P5 works differently from the others: we measure the tool gap on the
modification task, measure the same gap on the fresh-build version of the same
app, and test the *difference between the two gaps* (a
"difference-in-differences"). Our draft claims this difference is roughly zero,
so for P5, support means a confidence range hugging zero — a tight null, not a
significant effect.

## Named secondary comparisons (reported, but flagged as secondary)

S1: how much quality does the boot probe give up versus the full shell (a
confidence range, since the interesting result is "not much"). S2: screenshots
WITHOUT a shell versus the shell (the "is it the seeing or the running"
question). S3: screenshots versus shell on the performance task (predicted:
nothing). S4: the linter versus no tools at all (the expected null). S5:
write-your-own-tests versus the shell. S6: the screenshot question separately
for each model, with each model's screenshot count printed next to it, and an
explicit rule: a model that never took screenshots is "untestable," and no
per-model results get averaged together.

## Rules fixed in advance

No runs are excluded, ever. Missing token data drops a run from the cost
comparison only. Models absent from a condition (text-only models in the
screenshot arms) simply contribute nothing to that comparison. The random seed
is fixed (20260703) so anyone can reproduce every number exactly. The
significance threshold is 0.05. Nothing beyond the twelve named comparisons is
computed by the script; anything else we later want gets computed separately
and labeled exploratory.

## What comes out

`stats-results.txt`: for every comparison — the effect size in points, its 95%
confidence range, the raw and corrected p-values, and the six per-model
differences; plus an appendix table of mean, spread, and count for every
task-condition cell (this becomes the paper's Appendix F).
