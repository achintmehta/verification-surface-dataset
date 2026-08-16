# Live Seat Booking

A concurrency-safe seat-booking / ticketing service for a single event with a
fixed seat map. Built on a Node.js + Express backend with embedded
[PGLite](https://github.com/electric-sql/pglite) for raw SQL/transactions, and a
Vanilla-JS (Vite) single-page frontend. Seat-status transitions are pushed to
every connected client via Server-Sent Events (SSE).

## Features

- **Fixed seat map** (5 rows × 10 seats) persisted to local disk via PGLite.
- **Atomic holds with TTL**: a hold request acquires *all* requested seats or
  none (all-or-nothing). Held seats are unavailable to others until the hold
  expires, is released, or is confirmed.
- **Idempotent confirmation**: confirming a hold books its seats exactly once;
  repeated confirms return the same booking and book nothing extra.
- **Automatic expiry**: holds past their TTL are released — enforced lazily on
  every read/operation and by a periodic background sweep — without manual
  action.
- **Exact inventory**: `available + held(active) + booked == total` at all
  times. See `GET /api/inventory`.
- **Real-time**: every held / booked / released transition is broadcast over SSE
  so all seat maps stay live.

## How concurrency safety is guaranteed

1. All multi-statement mutations run through `transaction()` in `server/db.js`,
   which serializes transaction bodies through a promise queue **and** wraps
   them in SQL `BEGIN`/`COMMIT`. This prevents async interleaving of two
   request handlers' statements against the single embedded PGLite connection.
2. Within a hold/confirm, the targeted seat rows are locked with
   `SELECT ... FOR UPDATE` in a deterministic (`ORDER BY id`) order, then
   conditionally updated. Two concurrent requests for the same seat cannot both
   observe it as available — exactly one wins; the loser acquires none of its
   seats and gets a `409` with the conflicting ids.
3. Expiry is re-validated against the server clock *inside* the confirm
   transaction, so a hold that lapses can never be confirmed.

## Run it

```bash
npm install
npm run dev          # backend (:3001) + Vite frontend (:5173) together
```

Then open http://localhost:5173. The Vite dev server proxies `/api/*` (including
the SSE stream) to the backend on port 3001.

Backend only:

```bash
npm run start        # serves the API on :3001
```

## API

| Method | Path                          | Description                                  |
| ------ | ----------------------------- | -------------------------------------------- |
| GET    | `/api/seats`                  | Full seat map with effective statuses        |
| GET    | `/api/inventory`              | `{ available, held, booked, total }`         |
| POST   | `/api/holds`                  | `{ seatIds, sessionId }` → create hold (409 on conflict) |
| POST   | `/api/holds/:id/confirm`      | Confirm (book) a hold — idempotent           |
| DELETE | `/api/holds/:id`              | Release a hold early                         |
| GET    | `/api/stream`                 | SSE stream of seat-status transitions        |

## Configuration

Environment variables (see `server/config.js`):

- `PORT` (default `3001`)
- `PGLITE_DIR` (default `./server/.pgdata`)
- `HOLD_TTL_MS` (default `60000`)
