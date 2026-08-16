# Artifact Grader

Grades the **generated app** (the artifact), not the run transcript — so every run is scored identically regardless of condition (blind / self_built / visual), model, or whether the agent called `finish`. Designed for the layout `<group>/runs/<n>/app` and works unchanged on future spec runs, including seat-booking.

## Quick start

```bash
# one run
python3 automatic_probes.py path/to/kanban-board/runs/3

# everything, task auto-detected from path
python3 automatic_probes.py runs-root/*/runs/* \
        --out automatic_probes_results.jsonl --csv automatic_probes_results.csv

# future seat-booking runs (auto-detected via "seat" in path, or force it)
python3 automatic_probes.py seat-booking*/runs/* --task seat

# fresh runs without node_modules
python3 automatic_probes.py new-runs/*/runs/* --install
```

(The script was named grader.py before the 2026-07 pipeline refactor. It is
machine-only: filled human scorecards are scored by merge_results.py, never
here.)

Requirements: Linux (uses `ss` for port detection), Python 3.8+ stdlib only, `node`, `curl`. Run sequentially (apps bind their own ports; the grader detects the port by PID, so parallel grading risks cross-talk).

## How it works

Each run goes through four phases:

**1. Stage.** Copies app source (js/ts/json/html/css) to a scratch dir, excluding `node_modules`, data dirs, logs. Symlinks `node_modules` from the original (root and one level deep, e.g. `backend/node_modules`). With `--install` it runs `npm install` when no modules exist — this also implicitly grades whether `package.json` declares all dependencies, which is a real blind-condition failure mode.

**2. Static spec-fidelity scan** (no execution). Checks the mandated stack from the specs: `@electric-sql/pglite`, `express`, `cors` declared in any non-node_modules `package.json`; PGLite, `text/event-stream`, and `EventSource` referenced in source; and flags forbidden substitutions (sqlite3/better-sqlite3/pg/mysql/mongo deps, socket.io/ws usage). Produces `fidelity_score` (0–1, fraction of 8 checks passed). This is the quantitative measure of the "escape-hatch effect" — spec drift is scored even when the app works.

**3. Boot.** Finds the server entry (common paths like `server/index.js`, `backend/server.js`, falling back to any non-frontend file containing `text/event-stream`), starts it with `node`, and discovers the listening port by PID via `ss` (no assumptions about port choice). One forgiving retry: if the process dies citing a missing directory (`ENOENT … path: '...'`), the grader creates it and reboots — recorded in `notes` as `dir_assumption_fixed`, itself a defect signal worth counting.

**4. Functional probes.** Task-specific, weighted, each returning pass/fail plus an evidence string. Probes tolerate reasonable API-shape variation (e.g. `[...]` vs `{messages:[...]}`, `columnId` vs `column_id`, `/api/stream` vs `/api/events`, PATCH vs POST for moves) because the specs don't pin those down; what they don't tolerate is wrong behavior. SSE is consumed through real `curl -N` clients, so chunked encoding and event framing are handled exactly as a browser would.

`functional_pct` = weighted share of passed probes. Boot failure ⇒ 0% with the server log captured in the JSON for diagnosis.

## What it grades, per task

Weights in parentheses; probes marked ▲ are "deep" checks that a shallow smoke test misses — these are where the research signal lives.

### message-board
| probe | checks |
|---|---|
| post_message (2, critical) | `POST /api/messages` accepts text |
| get_messages (2, critical) | history endpoint returns the posted message |
| sse_endpoint (1) | an SSE endpoint with `text/event-stream` exists |
| sse_broadcast (3) ▲ | a connected SSE client actually receives a newly posted message |
| sse_multi_client (2) ▲ | **two** simultaneous clients both receive it (real fan-out, not last-client-wins) |
| persistence_restart (3) ▲ | post → `SIGKILL` → reboot → message still there (durable PGLite, not RAM) |
| rejects_empty (1) | empty/missing text is rejected with 4xx |

### kanban-board
| probe | checks |
|---|---|
| board_state (2, critical) | `GET /api/board` returns ≥3 ordered columns |
| create_card (2, critical) | card creation lands on the board |
| move_card (3) | cross-column move; card ends up in target column in **exactly one place** |
| reorder_within_column (3) ▲ | move with `afterId` produces the requested relative order |
| sse_endpoint (1) | SSE endpoint exists |
| sse_mutation_broadcast (3) ▲ | connected client receives a mutation event for a new card |
| persistence_restart (3) ▲ | board state survives `SIGKILL` + reboot |
| ordering_integrity_stress (3) ▲ | 25 cards + 24 repeated midpoint moves between the same neighbors: no card lost/duplicated, all positions unique and finite (exercises fractional-position renormalization, spec §3.5) |

### seat-booking (maps 1:1 to the spec's graded acceptance criteria)
| probe | checks |
|---|---|
| seat_map (2, critical) | `GET /api/seats` returns the seeded map with valid statuses |
| hold_acquire (2, critical) | `POST /api/holds` holds available seats, returns a hold id |
| hold_blocks_others (3) | second session cannot hold an already-held seat (409) |
| all_or_nothing (3) ▲ | mixed request (1 free + 1 held seat) acquires **nothing** (atomicity, spec §3.1) |
| confirm_books (2) | confirm transitions held → booked |
| confirm_idempotent (3) ▲ | double confirm books seats exactly once (spec §3.2) |
| release_hold (2) | `DELETE /api/holds/:id` returns seats to available |
| confirm_unknown_fails (2) | confirming a nonexistent hold fails, books nothing |
| concurrent_double_book (4) ▲ | **8 parallel holds on the same seat: exactly one 2xx** — the spec's no-double-booking criterion |
| seat_count_invariant (2) | every seat is in exactly one of available/held/booked |
| sse_endpoint (1) | SSE endpoint exists |
| sse_transition_broadcast (3) ▲ | connected client receives the seat-status transition |
| persistence_restart (3) ▲ | bookings survive `SIGKILL` + reboot |

Not probed (would need TTL control): natural hold expiry. If your seat spec lets the agent read TTL from an env var (e.g. `HOLD_TTL_MS`), add an expiry probe trivially — recommended for the next spec revision.

## Output

- `automatic_probes_results.jsonl` — one JSON object per run: identity (model/condition/status pulled from the run's `manifest.json` automatically), `fidelity` booleans + `fidelity_score`, `boot_ok`, per-probe `{ok, weight, evidence}`, `functional_pct`, `notes` (e.g. `dir_assumption_fixed`, `boot_crash`, `npm_install_run`), and the server log tail on boot failure. Machine-only: no visual/human fields (field-by-field reference: RESULTS-SCHEMA.md).
- `automatic_probes_results.csv` — flat matrix (one row per run, one column per probe) ready for pandas/R.

For the paper, the two headline columns are **`functional_pct`** (does it behave correctly under adversarial probing) and **`fidelity_score`** (did it stay on the mandated architecture) — by hypothesis, tool conditions should win the first and can lose the second.

## Extending to a new spec

Subclass `TaskModule`, implement `probes()` returning `[(Probe(name, weight, critical), fn)]` where `fn(app) -> (ok: bool, evidence: str)`, and register it in `TASKS` with a path keyword. Helpers you get for free: `http_json()`, `SSEClient`, `detect_stream_path()`, `app.restart()` for persistence probes, and threads for race probes. Anchor probe choice to the spec's "Acceptance Criteria (graded)" section, keep probes tolerant of payload-shape variance, and put the weight on behaviors a model can't fake without actually implementing them (broadcast, atomicity, persistence, races).

## Known limitations

- Frontend behavior (drag-and-drop UX, optimistic update + reconcile) is not graded — it would need a headless browser. The API-level reconcile contract (server-authoritative ordering) *is* covered by `move_card`/`reorder`/`stress`.
- Apps that hardcode a busy port will fail boot rather than retry; grade sequentially.
- The `dir_assumption_fixed` retry deliberately forgives one missing-directory crash so one packaging slip doesn't zero out an otherwise-working app; the note remains as a countable defect.
- Validated against: 4 real runs (message-board ×2 incl. one 100% and one boot-failure, kanban ×2 incl. the no-database run, blind kanban at 100%) and a purpose-built seat-booking reference app (13/13 probes).
