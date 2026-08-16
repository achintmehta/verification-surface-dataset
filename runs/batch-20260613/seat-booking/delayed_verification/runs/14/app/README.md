# Seat Booking

A single-event seat-booking / ticketing service with strict correctness under
concurrency. Users place temporary **holds** (with a TTL) on seats then
**confirm** them to book. No seat can be booked by two sessions, abandoned holds
auto-expire, inventory always balances, and every seat-status change is pushed
live to all viewers via Server-Sent Events.

## Stack

- **Backend:** Node.js + Express, embedded **PGLite** (PostgreSQL in-process,
  persisted to local disk) for raw SQL and transactions.
- **Real-time:** Server-Sent Events (`/api/stream`).
- **Frontend:** Vanilla JS SPA built with Vite.

## Run

```bash
npm install        # installs backend + frontend deps
npm run dev        # runs backend (3001) and Vite dev server (5173) together
```

Open http://localhost:5173. The Vite dev server proxies `/api/*` to the backend.

To run the backend alone (e.g. production): `npm start` then `npm run build` /
`npm run preview` for the static frontend.

## How correctness is guaranteed

- **Atomic acquisition (Decision 1):** every mutating operation runs through an
  in-process mutex *and* a SQL transaction. A hold is **all-or-nothing**: if any
  requested seat is unavailable the request acquires none and returns `409` with
  the conflicting seat ids.
- **Server-side expiry (Decision 2):** each hold stores `expires_at` computed on
  the server. Expiry is enforced on every read and before every hold/confirm,
  plus a periodic background sweep. Client timers are never trusted for
  inventory.
- **Idempotent confirmation (Decision 3):** confirming the same hold twice books
  the seats exactly once and returns the same booking. Confirming an expired or
  unknown hold fails and books nothing.

## API

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/api/seats` | All seats with effective status (expired holds reported available). |
| `POST` | `/api/holds` | `{ seatIds, sessionId }` → atomically hold all seats or `409` with conflicts. |
| `POST` | `/api/holds/:id/confirm` | Book the hold's seats; idempotent. |
| `DELETE` | `/api/holds/:id` | Release a hold early. |
| `GET` | `/api/stream` | SSE stream of seat-status transitions. |
| `GET` | `/api/inventory` | Diagnostic counts (available/held/booked/total). |

## Configuration (env vars)

- `PORT` (3001), `PGLITE_DIR` (`./pgdata`)
- `SEAT_ROWS` (5), `SEAT_PER_ROW` (10)
- `HOLD_TTL_MS` (120000), `SWEEP_INTERVAL_MS` (5000)
