# Live Seat Booking

A concurrency-safe seat-booking / ticketing service for a single event with a
fixed seat map. Users place temporary **holds** on seats, then **confirm** them
to book permanently. Built on an embedded **PGLite** database for raw SQL and
transactions, with **Server-Sent Events (SSE)** keeping every connected seat map
live.

## Guarantees

- **No double-booking.** Holds acquire every requested seat atomically with
  `SELECT ... FOR UPDATE` inside a transaction; under concurrent requests for
  the same seat, exactly one wins. The loser acquires *none* of its seats
  (all-or-nothing) and gets a `409` with the conflicting seat ids.
- **Auto-expiry.** Each hold records a server-computed `expires_at`. Expiry is
  enforced lazily on every read and before every hold/confirm operation, plus a
  periodic background sweep. Released seats are broadcast over SSE.
- **Idempotent confirmation.** Confirming the same hold twice books the seats
  exactly once and returns the same booking.
- **Exact inventory.** `available + held(active) + booked === total` at all
  times (see `GET /api/inventory`).

## Project layout

```
server/
  config.js     server + seat-map configuration
  db.js         PGLite init, schema, seat-map seeding
  sse.js        SSE client registry + broadcast helpers
  bookings.js   atomic hold / confirm / release / expiry logic
  index.js      Express server + routes + sweep
client/
  index.html    seat-map SPA
  main.js       rendering, selection, hold/confirm, SSE wiring
  style.css     styles
vite.config.js  frontend dev server (proxies /api -> :3001)
```

## Running

```bash
npm install
npm run dev      # runs backend (:3001) and Vite frontend (:5173) together
```

Or run them separately:

```bash
npm run server   # backend on http://localhost:3001
npm run client   # frontend on http://localhost:5173
```

Open http://localhost:5173. Open multiple tabs (or browsers) to watch holds,
bookings and expiries propagate live.

## Configuration (env vars)

| Var                 | Default | Meaning                          |
|---------------------|---------|----------------------------------|
| `PORT`              | 3001    | Backend port                     |
| `PGLITE_DIR`        | ./server/data/pgdata | PGLite data directory |
| `SEAT_ROWS`         | 5       | Rows in the seat map             |
| `SEAT_COLS`         | 10      | Seats per row                    |
| `HOLD_TTL_MS`       | 60000   | Hold time-to-live (ms)           |
| `SWEEP_INTERVAL_MS` | 5000    | Background expiry sweep interval |

## API

- `GET  /api/seats` — full seat map with effective status.
- `GET  /api/inventory` — `{ total, available, held, booked }`.
- `POST /api/holds` — `{ seatIds, sessionId }` → hold (or `409` with conflicts).
- `POST /api/holds/:holdId/confirm` — `{ sessionId }` → booking (idempotent).
- `DELETE /api/holds/:holdId` — release a hold early.
- `GET  /api/stream` — SSE stream of seat-status transitions.
