# Seat Booking

A concurrency-correct seat-booking / ticketing service for a single event with a
fixed seat map. Built with an embedded **PGLite** database (PostgreSQL in
Node.js), an **Express** API, **Server-Sent Events** for live seat-status
updates, and a lightweight **Vanilla JS + Vite** frontend.

## Features

- Fixed seat map (default **5 rows × 10 seats**) persisted to local disk via PGLite.
- **Atomic, all-or-nothing holds**: a hold for N seats succeeds only if *every*
  requested seat is currently available; otherwise it acquires nothing and
  returns `409` with the conflicting seat ids.
- **Time-based holds (TTL)**: each hold gets a server-computed `expires_at`.
- **Idempotent confirmation**: confirming the same hold twice books the seats
  exactly once.
- **Automatic expiry**: expired holds are released lazily on every read and
  hold/confirm operation, plus a periodic background sweep.
- **Exact inventory**: `available + held(active) + booked == total` always holds.
- **Real-time**: every seat transition (held / booked / released) is broadcast
  to all connected clients via SSE.

## Concurrency model

All seat-mutating operations run inside a single PGLite transaction and use
`SELECT ... FOR UPDATE` to lock the affected seat (and hold) rows. This
serializes concurrent acquisitions of the same seat, so under many concurrent
hold requests for the same seat **exactly one succeeds**. The hold transaction:

1. Releases any already-expired holds (so availability reflects reality).
2. Locks every requested seat row (`FOR UPDATE`).
3. Verifies all requested seats are effectively available; if not, aborts and
   acquires none.
4. Inserts the hold and flips all requested seats to `held` atomically.

Confirmation re-validates the hold's existence, expiry, and ownership of its
seats inside the transaction before booking, and short-circuits idempotently if
the hold is already `confirmed`.

## Getting started

```bash
npm install        # installs backend + frontend deps
npm run dev        # runs backend (3001) and Vite frontend (5173) together
```

Open http://localhost:5173. The Vite dev server proxies `/api/*` to the backend.

### Production-style run

```bash
npm run build      # builds the frontend into dist/
npm start          # runs the backend on port 3001
```

## Configuration (env vars)

| Variable            | Default   | Description                         |
| ------------------- | --------- | ----------------------------------- |
| `PORT`              | `3001`    | Backend HTTP port                   |
| `DB_DIR`            | `./pgdata`| PGLite persistence directory        |
| `ROWS`              | `5`       | Number of seat rows                 |
| `SEATS_PER_ROW`     | `10`      | Seats per row                       |
| `HOLD_TTL_MS`       | `60000`   | Hold lifetime in ms                 |
| `SWEEP_INTERVAL_MS` | `5000`    | Background expiry sweep interval ms |

## API

- `GET  /api/seats` — every seat with its effective status.
- `GET  /api/inventory` — `{ available, held, booked, total }`.
- `POST /api/holds` — `{ seatIds, sessionId }` → creates a hold or `409`.
- `POST /api/holds/:holdId/confirm` — `{ sessionId }` → books (idempotent).
- `DELETE /api/holds/:holdId` — releases a hold early.
- `GET  /api/stream` — SSE stream of seat-status changes.
