# Seat Booking

A single-event seat-booking / ticketing service that guarantees correctness
under concurrency: no seat is ever sold twice, abandoned holds expire
automatically, inventory always balances, and every connected client sees seat
status changes live via Server-Sent Events.

## Stack

- **Backend**: Node.js + Express, embedded **PGLite** (Postgres compiled to
  WASM) persisted to local disk for raw SQL and transactions.
- **Realtime**: Server-Sent Events (`/api/stream`).
- **Frontend**: Vanilla JS SPA built with Vite.

## Getting started

```bash
npm install        # installs backend + frontend deps
npm run dev        # runs backend (3001) and Vite dev server (5173) together
```

Open http://localhost:5173. The Vite dev server proxies `/api/*` to the backend.

For production-style serving:

```bash
npm run build      # builds the SPA into dist/
npm start          # runs the backend only
```

## How correctness is guaranteed

### Atomic seat acquisition (Decision 1)
`POST /api/holds` runs inside a single PGLite transaction. All mutating
operations are funnelled through one serialized in-process queue
(`withTransaction` in `server/db.js`), and seats are acquired with a conditional
`UPDATE ... WHERE status = 'available'` whose affected-row count must equal the
number of requested seats. If not, the transaction throws and rolls back, so the
request acquires **none** of its seats and returns **409** with the conflicting
seat ids (all-or-nothing).

### Server-side time-based expiry (Decision 2)
Every hold stores `expires_at = now + TTL` computed on the server. Expiry is
enforced lazily before **every** read, hold and confirm via
`releaseExpiredWithin`, and a background sweep (`/server/index.js`) also releases
stale holds every few seconds. Released seats are broadcast over SSE. The client
never frees inventory on its own timer.

### Idempotent confirmation (Decision 3)
`POST /api/holds/:holdId/confirm` re-validates the hold's existence, active
status, non-expiry and seat ownership **inside** the transaction before booking.
A confirmed hold is recorded as `confirmed`; a repeat confirm returns the same
booked seats and books nothing more. Expired/unknown holds fail and book
nothing.

## API

| Method & path                       | Description                                              |
| ----------------------------------- | ------------------------------------------------------- |
| `GET /api/seats`                    | All seats with *effective* status (expired holds shown available) |
| `GET /api/inventory`                | Counts: available / held / booked / total               |
| `POST /api/holds`                   | `{ seatIds, sessionId }` → atomic all-or-nothing hold   |
| `POST /api/holds/:holdId/confirm`   | Book held seats; idempotent                             |
| `DELETE /api/holds/:holdId`         | Release a hold early                                    |
| `GET /api/stream`                   | SSE stream of seat transitions (snapshot + live updates)|

## Configuration

Environment variables (all optional):

| Var                 | Default                | Meaning                          |
| ------------------- | ---------------------- | -------------------------------- |
| `PORT`              | `3001`                 | Backend HTTP port                |
| `PGLITE_DIR`        | `./server/data/pgdata` | PGLite persistence directory     |
| `SEAT_ROWS`         | `5`                    | Number of rows                   |
| `SEATS_PER_ROW`     | `10`                   | Seats per row                    |
| `HOLD_TTL_MS`       | `60000`                | Hold time-to-live                |
| `SWEEP_INTERVAL_MS` | `5000`                 | Background expiry sweep interval |
