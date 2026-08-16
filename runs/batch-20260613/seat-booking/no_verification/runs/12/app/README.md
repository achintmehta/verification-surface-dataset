# Seat Booking

A concurrency-correct seat-booking / ticketing service for a single event,
built on **embedded PGLite** (raw SQL + transactions) with a **Vanilla JS /
Vite** frontend kept live via **Server-Sent Events (SSE)**.

## Highlights

- **Fixed seat map** (5 rows × 10 seats by default) persisted to local disk.
- **Atomic holds with TTL**: a hold acquires *all* requested seats or *none*
  (all-or-nothing). Conflicting seats are reported with a `409`.
- **Idempotent confirmation**: confirming the same hold twice books the seats
  exactly once.
- **Automatic expiry**: holds past their TTL are released lazily (on every
  read / before every operation) and by a periodic sweep — no client timer is
  trusted.
- **Exact inventory**: `available + held(active) + booked == total` always.
- **Real-time**: every seat transition (held / booked / released) is broadcast
  over SSE so all seat maps converge.

## Project layout

```
backend/
  config.js     # ports, TTL, sweep interval, seat-map dimensions, db path
  db.js         # PGLite init, schema, seed, write mutex
  booking.js    # atomic hold / confirm / release / sweep + inventory
  sse.js        # SSE connection registry & broadcasting
  server.js     # Express routes + SSE endpoint + periodic sweep
frontend/
  index.html    # SPA shell
  style.css     # seat grid styling & states
  main.js       # rendering, selection, hold/confirm/release, EventSource
vite.config.js  # dev server + /api proxy to the backend
```

## Running

Install dependencies (provisioned from `package.json`):

```bash
npm install
```

Run backend + frontend together:

```bash
npm run dev
```

- Backend: http://localhost:3000
- Frontend (Vite dev server, proxies `/api`): http://localhost:5173

Or run individually:

```bash
npm run dev:backend   # node backend/server.js
npm run dev:frontend  # vite
```

## Configuration (env vars)

| Var                 | Default            | Meaning                          |
| ------------------- | ------------------ | -------------------------------- |
| `PORT`              | `3000`             | Backend HTTP port                |
| `HOLD_TTL_MS`       | `60000`            | Hold time-to-live (ms)           |
| `SWEEP_INTERVAL_MS` | `5000`             | Periodic expiry sweep interval   |
| `ROWS`              | `5`                | Seat-map rows                    |
| `SEATS_PER_ROW`     | `10`               | Seats per row                    |
| `DB_DIR`            | `./data/pgdata`    | PGLite data directory            |

## API

| Method & path                     | Body                       | Behaviour |
| --------------------------------- | -------------------------- | --------- |
| `GET /api/seats`                  | —                          | All seats with effective status (`+ holdTtlMs`). |
| `GET /api/inventory`              | —                          | Reconciled counts. |
| `POST /api/holds`                 | `{ seatIds, sessionId }`   | Atomic all-or-nothing hold. `201` hold or `409 { conflicts }`. |
| `POST /api/holds/:holdId/confirm` | `{ sessionId }`            | Idempotent booking. `410` if expired, `404` if unknown. |
| `DELETE /api/holds/:holdId`       | —                          | Release a hold early. |
| `GET /api/stream`                 | —                          | SSE stream of `seats-changed` events. |

## How concurrency correctness is guaranteed

PGLite runs a single embedded Postgres instance. All seat-mutating critical
sections (`createHold`, `confirmHold`, `releaseHold`, sweeps, and the
lazy-expiry read) run inside a process-level async **write mutex** and a SQL
**transaction** with `SELECT ... FOR UPDATE` on the targeted seats. This makes
each hold acquisition an atomic check-and-set across all requested seats: under
many concurrent requests for the same seat, exactly one succeeds and the others
receive a `409` listing the conflicting seats and acquire nothing.

Expiry is enforced server-side from `hold_expires_at`: it is applied on every
read and before every operation, and a background sweep additionally releases
stale holds — releases are broadcast over SSE so all clients converge.
