# 🎟️ Seat Booking — Live (PGLite + SSE)

A single-event seat-booking service that guarantees correctness under
concurrency: no seat is ever booked twice, abandoned holds auto-expire, and
inventory always reconciles. Built on an embedded **PGLite** database with raw
SQL/transactions, an **Express** API, **Server-Sent Events** for live seat-map
updates, and a lightweight **Vanilla JS / Vite** frontend.

## Architecture

```
client/ (Vite SPA)        server/ (Node + Express + PGLite)
  index.html                index.js        — Express app, routes, SSE endpoint
  main.js                    seatService.js — atomic holds / confirm / release / expiry
  style.css                  db.js          — PGLite init + fixed seat-map seed
  vite.config.js             sse.js         — SSE connection hub + broadcast
                             config.js      — seat map size, hold TTL, ports
```

### Correctness model

- **Atomic acquisition (Decision 1):** Every hold runs inside a single PGLite
  transaction *and* a server-side serialization queue (`runExclusive`). A hold
  for N seats checks that every requested seat is effectively available, then
  marks them all `held` — all-or-nothing. Two concurrent requests for the same
  seat can never both succeed; the loser gets a `409` with the conflicting ids.
- **Server-side TTL expiry (Decision 2):** Each hold stores `hold_expires_at`.
  Expired holds are released (a) lazily on every seat read, (b) at the start of
  every hold/confirm/release operation, and (c) by a periodic background sweep.
  Released seats are broadcast over SSE. Client timers are never trusted.
- **Idempotent confirmation (Decision 3):** Confirm re-validates the hold's
  existence and expiry inside the transaction before booking. A second confirm
  of the same hold returns the same booking and books nothing additional.

### Inventory invariant

At all times: `available + held(active) + booked === total seats`. A `held` seat
whose `hold_expires_at` is in the past is reported (and treated) as `available`,
so the effective counts always reconcile.

## API

| Method | Path                          | Body                          | Description |
| ------ | ----------------------------- | ----------------------------- | ----------- |
| GET    | `/api/seats`                  | —                             | Effective seat map + inventory |
| POST   | `/api/holds`                  | `{ seatIds, sessionId }`      | Atomic, all-or-nothing hold. `409` on conflict |
| POST   | `/api/holds/:holdId/confirm`  | `{ sessionId }`               | Idempotent booking |
| DELETE | `/api/holds/:holdId`          | —                             | Release a hold early |
| GET    | `/api/stream`                 | — (SSE)                       | Live snapshot + `seats` transition events |

## Running

```bash
npm install
npm run dev      # starts the API (3001) and the Vite dev server (5173)
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the backend.

Production-style:

```bash
npm run build    # builds the SPA into dist/
npm start        # runs the API server
```

### Configuration (env vars)

| Var | Default | Meaning |
| --- | ------- | ------- |
| `PORT` | `3001` | API/SSE port |
| `DATA_DIR` | `./.pgdata` | PGLite data directory |
| `ROWS` | `5` | seat-map rows |
| `SEATS_PER_ROW` | `10` | seats per row |
| `HOLD_TTL_MS` | `60000` | hold time-to-live |
| `SWEEP_INTERVAL_MS` | `5000` | background expiry sweep interval |

## Try the concurrency guarantees

1. Open two browser windows (each gets its own session id).
2. Select the same seats in both, click **Hold** at the same time — only one
   succeeds; the other sees a `409` and the conflicting seats flash.
3. Hold seats and wait out the countdown — the seats free up automatically and
   both windows update live.
4. Confirm a hold, then confirm again (reload + retry) — booked exactly once.
