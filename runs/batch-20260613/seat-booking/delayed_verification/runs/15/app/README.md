# Seat Booking

A concurrency-correct seat-booking / ticketing service for a single event with a
fixed seat map. Users place temporary **holds** on seats, then **confirm** them
to book. The system guarantees:

- **No double-booking** — atomic, all-or-nothing seat acquisition.
- **Auto-expiry** — abandoned holds are released after their TTL (lazy on every
  read/operation + a periodic sweep).
- **Idempotent confirmation** — confirming twice books exactly once.
- **Exact inventory** — `available + active-held + booked == total` at all times.
- **Live seat maps** — every status transition is pushed to all clients via SSE.

## Architecture

```
backend/   Node.js + Express + embedded PGLite (raw SQL + transactions)
frontend/  Vanilla JS SPA built with Vite, interactive seat grid + EventSource
```

### Backend

- `src/config.js`   — configuration (seat map size, TTL, sweep interval).
- `src/db.js`       — PGLite init, schema, and seat-map seeding (persisted to disk).
- `src/booking.js`  — the correctness-critical logic: lazy expiry, atomic holds,
                      transactional/idempotent confirm, early release, sweep.
- `src/sse.js`      — SSE connection registry and broadcasting.
- `src/server.js`   — Express routes and the periodic sweep.

#### API

| Method | Path                          | Description                                   |
| ------ | ----------------------------- | --------------------------------------------- |
| GET    | `/api/seats`                  | Full seat map with effective status + counts. |
| GET    | `/api/inventory`              | Inventory counts.                             |
| POST   | `/api/holds`                  | `{ seatIds, sessionId }` → atomic hold (409 on conflict). |
| POST   | `/api/holds/:holdId/confirm`  | Confirm a hold (idempotent).                  |
| DELETE | `/api/holds/:holdId`          | Release a hold early.                          |
| GET    | `/api/stream`                 | SSE stream of seat-status transitions.        |

### Concurrency model

PGLite runs a single embedded Postgres instance over one connection, so
`db.transaction(...)` calls execute **serially**. Combined with conditional
`UPDATE ... WHERE status = 'available'` guards and `SELECT ... FOR UPDATE`, this
makes it impossible for two requests to acquire the same seat: the losing request
sees no eligible rows and the whole hold is rolled back (all-or-nothing 409).

Expiry is enforced **lazily** at the start of every read and every
hold/confirm/release operation (`releaseExpiredHolds`), and additionally by a
periodic sweep, so abandoned holds free up even without traffic. Released seats
are broadcast over SSE so all clients converge.

## Running

```bash
# Install everything (root tooling + backend + frontend)
npm run install:all

# Run backend (http://localhost:3001) and frontend (http://localhost:5173) together
npm run dev
```

The frontend dev server proxies `/api/*` to the backend, so open
<http://localhost:5173>. Open it in several tabs (each gets its own session id)
to watch holds/bookings sync live.

### Configuration (env vars)

| Var                | Default  | Meaning                          |
| ------------------ | -------- | -------------------------------- |
| `PORT`             | `3001`   | Backend port.                    |
| `PGLITE_DIR`       | `./pgdata` | PGLite data directory.         |
| `SEAT_ROWS`        | `5`      | Number of rows.                  |
| `SEATS_PER_ROW`    | `10`     | Seats per row.                   |
| `HOLD_TTL_MS`      | `120000` | Hold time-to-live (ms).          |
| `SWEEP_INTERVAL_MS`| `5000`   | Periodic expiry sweep interval.  |
