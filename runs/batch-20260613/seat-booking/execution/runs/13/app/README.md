# 🎟️ Live Seat Booking

A concurrency-safe seat-booking / ticketing service for a single event with a
fixed seat map. Users place temporary **holds** on seats, then **confirm** them
to book permanently. The system guarantees:

- No seat is ever booked by two different sessions.
- Active holds block others until they expire, are released, or are confirmed.
- Abandoned holds expire automatically (TTL) and free their seats.
- Confirming an expired/unknown hold fails and books nothing.
- Confirmation is **idempotent** — repeated confirms book exactly once.
- Inventory always balances: `available + held(active) + booked = total`.
- Every seat-status transition is pushed live to all clients via **SSE**.

## Architecture

- **Backend**: Node.js + Express, with **embedded PGLite** (`@electric-sql/pglite`)
  for raw SQL and transactions, persisting seat state to local disk.
- **Concurrency model**: every *mutating* seat operation is serialised through a
  promise queue (PGLite is a single embedded connection) **and** guarded by
  all-or-nothing conditional SQL `UPDATE`s. Two requests can never acquire or
  book the same seat.
- **Expiry**: each hold stores `expires_at`. Expired holds are released lazily on
  every read and before every hold/confirm, plus a periodic background sweep.
- **Real-time**: `GET /api/stream` is an SSE endpoint that broadcasts every
  `held` / `booked` / `released` transition.
- **Frontend**: Vanilla JS SPA built with Vite, rendering an interactive seat
  grid that updates live via `EventSource`.

## Project layout

```
server/
  config.js        # seat-map size, TTL, ports
  db.js            # PGLite init + schema + seed
  seatService.js   # atomic hold / confirm / release / expiry logic
  sse.js           # SSE client registry + broadcast
  index.js         # Express app, routes, sweeper, bootstrap
frontend/
  index.html       # seat grid + controls
  style.css
  main.js          # rendering, hold/confirm flow, SSE, countdown
test/
  seatService.test.js  # correctness + concurrency tests
```

## Running

Install dependencies:

```bash
npm install
```

Run backend + frontend together (dev):

```bash
npm run dev
```

- Backend API: http://localhost:3001
- Frontend (Vite, proxies `/api` → backend): http://localhost:5173

Or run them separately:

```bash
npm run server     # backend only on :3001
npm run frontend   # Vite dev server on :5173
```

Production build of the frontend:

```bash
npm run build      # outputs to ./dist
```

## Tests

```bash
npm test
```

Covers seeding, holds, all-or-nothing conflicts (409), idempotent confirmation,
expiry, release, the background sweep, ownership checks, and — most importantly —
heavy concurrency: dozens of simultaneous requests racing for the same seat where
exactly one wins, and inventory remaining exact under mixed concurrent ops.

## API

| Method & path                       | Description                                                        |
|-------------------------------------|--------------------------------------------------------------------|
| `GET /api/seats`                    | All seats with effective status (expired holds reported available).|
| `GET /api/inventory`                | Counts of available / held / booked / total.                       |
| `POST /api/holds`                   | `{ seatIds, sessionId }` → atomically hold all or none (409 on conflict with `conflictSeatIds`). |
| `POST /api/holds/:id/confirm`       | `{ sessionId }` → book the held seats; idempotent.                 |
| `DELETE /api/holds/:id`             | Release a hold early.                                              |
| `POST /api/holds/:id/release`       | Beacon-friendly release (used on tab close).                       |
| `GET /api/stream`                   | SSE: `snapshot` once, then `seats` events for every transition.    |
| `GET /api/health`                   | Liveness + connected SSE client count.                             |

## Configuration (env vars)

| Var                 | Default | Meaning                          |
|---------------------|---------|----------------------------------|
| `PORT`              | `3001`  | Backend port                     |
| `PGLITE_DIR`        | `./pgdata` | PGLite data directory         |
| `SEAT_ROWS`         | `5`     | Number of rows                   |
| `SEATS_PER_ROW`     | `10`    | Seats per row                    |
| `HOLD_TTL_MS`       | `120000`| Hold time-to-live (ms)           |
| `SWEEP_INTERVAL_MS` | `5000`  | Background expiry sweep interval |
