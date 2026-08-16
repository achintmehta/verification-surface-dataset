# Seat Booking

A concurrency-safe seat-booking / ticketing service for a single event with a
fixed seat map. Built with a Node.js + Express backend, **embedded PGLite** for
raw SQL and transactions, and a Vanilla JS + Vite frontend. Real-time seat
status is pushed to every client via **Server-Sent Events (SSE)**.

## Highlights

- **Atomic hold acquisition** — a hold for N seats is all-or-nothing. Under many
  concurrent requests for the same seat, exactly one wins; losers receive a
  `409` listing the conflicting seat ids and acquire nothing.
- **Server-side TTL expiry** — each hold has `expires_at = now + TTL`. Expiry is
  enforced lazily on every read and before every hold/confirm/release, plus a
  periodic background sweep. Client timers are never trusted to free inventory.
- **Idempotent confirmation** — confirming the same hold twice books the seats
  exactly once and returns the same booking.
- **Exact inventory** — `available + held(active) + booked` always equals the
  total seat count, even under concurrent load.
- **Live updates** — every seat transition (held / booked / released) is
  broadcast over SSE so all open seat maps converge.

## Getting started

```bash
npm install
npm run dev        # runs backend (:3001) and Vite frontend (:5173) together
```

Then open http://localhost:5173. Open it in two browser tabs/windows to watch
holds and bookings propagate live.

### Individual processes

```bash
npm run dev:server   # backend only, http://localhost:3001
npm run dev:client   # Vite dev server only, proxies /api -> :3001
npm start            # production-style backend
npm run build        # build the frontend into dist/
```

### Tests

```bash
npm test
```

The test suite (`test/concurrency.test.js`) exercises the acceptance criteria
directly against the booking engine: single-winner races, idempotent confirms,
TTL expiry, expired/unknown confirm rejection, early release, and inventory
balance under high-volume mixed operations.

## API

| Method | Path                          | Description                                              |
| ------ | ----------------------------- | -------------------------------------------------------- |
| GET    | `/api/seats`                  | All seats with effective status (expired holds appear available). |
| GET    | `/api/inventory`              | `{ available, held, booked, total }`.                    |
| POST   | `/api/holds`                  | Body `{ seatIds, sessionId }`. Atomic all-or-nothing hold. `201` or `409`. |
| POST   | `/api/holds/:holdId/confirm`  | Book the held seats. Idempotent. `200` / `404` / `410`.  |
| DELETE | `/api/holds/:holdId`          | Release a hold early.                                     |
| GET    | `/api/stream`                 | SSE stream: `snapshot` + `seats` transition events.      |
| GET    | `/api/health`                 | Liveness + SSE client count.                             |

## Configuration (env vars)

| Var                 | Default     | Meaning                          |
| ------------------- | ----------- | -------------------------------- |
| `PORT`              | `3001`      | Backend HTTP port.               |
| `DB_DIR`            | `./pgdata`  | PGLite on-disk data directory.   |
| `ROWS`              | `5`         | Seat map rows.                   |
| `SEATS_PER_ROW`     | `10`        | Seats per row.                   |
| `HOLD_TTL_MS`       | `60000`     | Hold time-to-live (ms).          |
| `SWEEP_INTERVAL_MS` | `5000`      | Background expiry sweep interval.|

## How concurrency safety works

PGLite runs on a single connection, executing statements serially. The booking
engine wraps each logical operation in a `db.transaction()` and additionally
serializes operations through an in-process promise queue, so a hold/confirm/
release runs to completion atomically. Seat acquisition uses a conditional
`UPDATE ... WHERE status = 'available'` and verifies the affected row count
equals the request size; a mismatch aborts the transaction, guaranteeing the
all-or-nothing property. Confirmation re-validates the hold's existence,
ownership, and expiry inside the same transaction before booking.
