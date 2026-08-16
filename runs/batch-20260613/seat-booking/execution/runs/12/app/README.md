# 🎟️ Seat Booking

A concurrency-correct seat-booking / ticketing service for a single event with a
fixed seat map. Users place temporary **holds** on seats (with a TTL), then
**confirm** those holds to **book** the seats. The system guarantees:

- **No double-booking** — a seat is never booked by two different sessions.
- **Atomic all-or-nothing holds** — a hold for N seats succeeds only if *every*
  requested seat is available; otherwise it acquires none and returns the
  conflicting seat ids.
- **Automatic expiry** — abandoned holds are released after their TTL, both
  lazily (on every read/mutation) and via a periodic sweep.
- **Idempotent confirmation** — confirming the same hold twice books seats
  exactly once.
- **Exact inventory** — `available + held(active) + booked == total` at all times.
- **Live updates** — every seat-status transition is pushed to all connected
  clients via Server-Sent Events (SSE).

## Stack

- **Backend:** Node.js + Express, with embedded **PGLite** (PostgreSQL in-process)
  persisting seat state to local disk. Raw SQL + transactions enforce
  correctness.
- **Frontend:** Vanilla JS SPA built with **Vite**, rendering an interactive seat
  grid and consuming the SSE stream via `EventSource`.

## Getting started

```bash
npm install

# Run backend + frontend dev servers together:
npm run dev
#   backend  -> http://localhost:3001
#   frontend -> http://localhost:5173  (proxies /api to the backend)

# Or run individually:
npm run dev:server
npm run dev:client

# Production build of the frontend:
npm run build && npm run preview

# Concurrency / correctness test suite (in-process, no HTTP):
npm test
```

## Configuration (env vars)

| Variable             | Default     | Description                          |
|----------------------|-------------|--------------------------------------|
| `PORT`               | `3001`      | Backend port                         |
| `DB_DIR`             | `./pgdata`  | PGLite persistence directory         |
| `SEAT_ROWS`          | `5`         | Number of rows                       |
| `SEAT_COLS`          | `10`        | Seats per row                        |
| `HOLD_TTL_MS`        | `60000`     | Hold time-to-live in ms              |
| `SWEEP_INTERVAL_MS`  | `5000`      | Background expiry sweep interval     |

## API

| Method & path                       | Description |
|-------------------------------------|-------------|
| `GET /api/seats`                    | All seats with effective status + inventory counts. Expired holds are reported (and persisted) as available. |
| `GET /api/inventory`                | `{ available, held, booked, total }`. |
| `POST /api/holds`                   | Body `{ seatIds, sessionId }`. Atomically holds all seats or returns **409** `{ error, conflicts }`. On success **201** with the hold. |
| `POST /api/holds/:holdId/confirm`   | Body `{ sessionId }`. Books the hold's seats. Idempotent. Expired/unknown holds fail (**410**/**404**) and book nothing. |
| `DELETE /api/holds/:holdId`         | Releases a hold early, returning its seats to available. |
| `GET /api/stream`                   | SSE stream. Emits `hello` then `seats` events `{ seats, at }` on every transition. |
| `GET /api/health`                   | Liveness + connected SSE client count. |

## How correctness is enforced

1. **Serialized write transactions** — a small in-process async mutex serializes
   PGLite write transactions, and each hold acquisition uses a conditional
   `UPDATE ... WHERE status = 'available'` that re-checks availability and
   requires the affected-row count to equal the request size (all-or-nothing,
   else rollback).
2. **Server-side TTL expiry** — `expires_at` is computed on the server. Stale
   holds are released inside every read/hold/confirm transaction, plus a periodic
   sweep. Client timers are advisory only.
3. **Idempotent confirm** — confirmation re-validates the hold's existence,
   status, ownership, and expiry inside the transaction; a hold already
   `confirmed` returns its existing booking without booking anything new.
4. **Broadcast after commit** — changed seats are collected during the
   transaction and broadcast over SSE only after it commits, so every client
   converges to the same state.

See `test/concurrency.test.js` for the executable acceptance checks.
