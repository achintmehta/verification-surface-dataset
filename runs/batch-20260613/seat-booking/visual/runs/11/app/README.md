# Live Seat Booking

A concurrency-safe seat-booking / ticketing service for a single event with a
fixed seat map. Built on an embedded PostgreSQL (PGLite) database with
Server-Sent Events (SSE) keeping every connected seat map live.

## Architecture

- **Backend** — Node.js + Express, embedded **PGLite** (raw SQL + transactions),
  persisting to local disk.
- **Real-time** — SSE (`GET /api/stream`) broadcasts every seat transition
  (held / booked / released) to all clients.
- **Frontend** — Vanilla JS SPA built with Vite; an interactive seat grid that
  reflects live state via `EventSource`.

## Correctness model

- **Atomic acquisition** — A hold places *all* requested seats or *none*
  (all-or-nothing). Seat rows are `SELECT ... FOR UPDATE`-locked inside a
  transaction and every write operation is serialized by an in-process lock
  queue, so two concurrent requests for the same seat can never both succeed.
  The loser receives `409` with the conflicting seat ids.
- **Server-side TTL expiry** — Each hold stores `expires_at = now + TTL`.
  Expiry is enforced lazily on every seat read and at the start of every
  hold/confirm/release transaction, plus a periodic background sweep. Released
  seats are broadcast. No client timer is ever trusted to free inventory.
- **Idempotent confirmation** — Confirming an already-confirmed hold returns the
  same booking and books nothing more. Confirming an expired/unknown hold fails
  and books nothing (re-validated inside the confirm transaction).
- **Exact inventory** — `available + held(active) + booked == total` at all times.

## API

| Method | Path                          | Description                                   |
| ------ | ----------------------------- | --------------------------------------------- |
| GET    | `/api/seats`                  | All seats with effective status + inventory.  |
| GET    | `/api/inventory`              | Aggregate counts.                             |
| POST   | `/api/holds`                  | `{ seatIds, sessionId }` → hold (or 409).     |
| POST   | `/api/holds/:holdId/confirm`  | `{ sessionId }` → booking (idempotent).       |
| DELETE | `/api/holds/:holdId`          | Release a hold early.                         |
| GET    | `/api/stream`                 | SSE stream of seat transitions.               |

## Configuration (env)

| Var           | Default  | Meaning                          |
| ------------- | -------- | -------------------------------- |
| `PORT`        | `3001`   | Server port.                     |
| `PGLITE_DIR`  | `./data/pgdata` | PGLite data directory.    |
| `HOLD_TTL_MS` | `120000` | Hold time-to-live (ms).          |
| `SEAT_ROWS`   | `5`      | Number of rows.                  |
| `SEAT_COLS`   | `10`     | Seats per row.                   |

## Running

```bash
npm install

# Dev: backend (3001) + Vite frontend (5173, proxies /api -> 3001)
npm run dev

# Production-style: build the SPA and serve it from the Node server
npm run build
npm start            # http://localhost:3001
```

## Tests

```bash
npm test
```

Boots a server with a short TTL on a temp data dir and verifies the acceptance
criteria: exactly-one-winner under concurrent holds, all-or-nothing acquisition,
idempotent confirmation, automatic expiry, no double-booking under load, and
inventory balance.
