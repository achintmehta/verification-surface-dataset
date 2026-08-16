# Live Seat Booking

A concurrency-safe seat-booking / ticketing service for a single event with a
fixed seat map. Users place temporary **holds** on seats, then **confirm** them
to book. The system guarantees no seat is ever booked by two sessions,
auto-expires abandoned holds, and keeps inventory exact under concurrent load.
Seat-status changes are pushed live to every connected client via SSE.

## Stack

- **Backend:** Node.js + Express + embedded [PGlite](https://github.com/electric-sql/pglite) (raw SQL + transactions, persisted to local disk).
- **Realtime:** Server-Sent Events (`/api/stream`).
- **Frontend:** Vanilla JS SPA built with Vite, rendering an interactive seat grid.

## Install & Run

```bash
npm install

# Run backend + frontend dev servers together:
npm run dev
# Frontend: http://localhost:5173  (proxies /api -> backend on :3001)

# Or run just the backend:
npm run start
```

The Vite dev server proxies `/api/*` (including the SSE stream) to the backend,
so the SPA uses same-origin relative URLs.

## How correctness is guaranteed

### Atomic seat acquisition (no double-booking)
`POST /api/holds` runs inside a single PGLite transaction guarded by an
in-process async mutex (`server/locks.js`). It reads the requested seats,
fails the **whole** request (409 + conflicting ids) if any is unavailable, and
otherwise flips them to `held` with a conditional `UPDATE ... WHERE status =
'available'`. The mutex serializes overlapping check-and-set sequences, so for
N concurrent requests on the same seat exactly one wins.

### Server-side TTL expiry
Each hold stores `expires_at = now + TTL` computed on the server. Expiry is
enforced **on every seat read and before every hold/confirm/release**
(`expireStaleHolds`) plus a periodic background sweep. Released seats are
broadcast so clients update. Client timers are never trusted to free inventory.

### Idempotent, transactional confirmation
`POST /api/holds/:id/confirm` re-validates the hold's existence, ownership, and
expiry inside the transaction before booking. Confirming an already-confirmed
hold returns the same booking and books nothing extra. Expired/unknown holds
fail and book nothing.

### Exact inventory
At all times `available + held(active) + booked == total`. Expired holds no
longer count as `held` because expiry runs before any count is read.

## API

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/seats` | All seats with effective status (expiry applied). |
| GET | `/api/inventory` | Reconciled counts `{ available, held, booked, total }`. |
| POST | `/api/holds` | `{ seatIds, sessionId }` → atomic all-or-nothing hold. 409 on conflict. |
| POST | `/api/holds/:holdId/confirm` | Book the hold's seats (idempotent). |
| DELETE | `/api/holds/:holdId` | Release a hold early. |
| GET | `/api/stream` | SSE stream of seat-status transitions. |

## Configuration (env vars)

| Var | Default | Meaning |
| --- | ------- | ------- |
| `PORT` | `3001` | Backend port |
| `DB_DIR` | `./server/.pgdata` | PGLite data directory |
| `SEAT_ROWS` | `5` | Rows in the seat map |
| `SEATS_PER_ROW` | `10` | Seats per row |
| `HOLD_TTL_MS` | `60000` | Hold time-to-live |
| `SWEEP_INTERVAL_MS` | `5000` | Background expiry sweep interval |
