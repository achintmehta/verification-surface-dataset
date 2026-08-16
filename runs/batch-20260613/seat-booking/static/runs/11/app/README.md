# Seat Booking

A concurrency-correct seat-booking service for a single event with a fixed
seat map. Built with a Node.js + Express backend on embedded **PGLite**, with
**Server-Sent Events** pushing live seat-status changes to a Vanilla JS / Vite
frontend.

## Features

- Fixed seat map (5 rows × 10 seats) persisted in PGLite on local disk.
- **Atomic hold acquisition** — a hold for N seats succeeds only if *every*
  requested seat is available (all-or-nothing). Concurrent requests for the
  same seat: exactly one wins, the loser gets `409` with the conflicting ids.
- **Hold TTL** with lazy + periodic expiry. Stale holds are released on every
  read and every hold/confirm operation, plus a background sweep.
- **Transactional, idempotent confirmation** — confirming an active hold books
  its seats exactly once; a repeat confirm returns the same booking and books
  nothing extra; confirming an expired/unknown hold fails and books nothing.
- **Exact inventory** — `available + held(active) + booked == total` always.
- **Real-time** — every transition (held / booked / released) is broadcast over
  SSE so all clients stay in sync.

## Quick start

```bash
npm install
npm run dev        # runs backend (3001) + Vite frontend (5173)
```

- Frontend: http://localhost:5173 (proxies `/api` to the backend)
- Backend:  http://localhost:3001

Run the backend alone with `npm run dev:server`.

## API

| Method | Path                          | Description                                   |
|--------|-------------------------------|-----------------------------------------------|
| GET    | `/api/seats`                  | All seats with effective status               |
| POST   | `/api/holds`                  | `{ seatIds, sessionId }` → atomic hold or 409  |
| POST   | `/api/holds/:holdId/confirm`  | Confirm hold (idempotent)                      |
| DELETE | `/api/holds/:holdId`          | Release a hold early                           |
| GET    | `/api/stream`                 | SSE stream of seat-status transitions          |

## Concurrency model

Each hold acquisition opens a PGLite transaction that:
1. Releases any expired holds.
2. `SELECT ... FOR UPDATE` locks the requested seats (ordered by id to avoid
   deadlocks), serializing competing acquisitions.
3. Verifies every seat is `available`; otherwise returns the conflict set and
   acquires nothing.
4. Performs a conditional `UPDATE ... WHERE status = 'available'` and asserts it
   flipped exactly the requested rows, rolling back otherwise.

Confirmation re-validates the hold's seats `FOR UPDATE` inside one transaction,
booking only seats still `held` under that hold id, and treats an
already-booked hold as an idempotent success.

## Config

Environment variables (see `server/config.js`): `PORT`, `HOLD_TTL_MS`,
`SWEEP_INTERVAL_MS`, `DATA_DIR`.
