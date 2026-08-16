# Live Seat Booking

A concurrency-correct seat-booking / ticketing service for a single event, built
on **Node.js + Express**, an **embedded PGLite** database (persisted to local
disk), and **Server-Sent Events (SSE)** for live seat-map updates. The frontend
is a lightweight Vanilla-JS SPA built with **Vite**.

## Features

- Fixed seat map (5 rows × 10 seats = 50 seats) persisted in PGLite.
- **Atomic hold acquisition** — a hold request acquires *all* requested seats or
  *none* (all-or-nothing). Under concurrent requests for the same seat, exactly
  one succeeds; the rest receive `409` with the conflicting seat ids.
- **Hold TTL** — every hold records a server-computed `expires_at`. Expired
  holds are released lazily on every read/operation and by a periodic sweep.
- **Idempotent confirmation** — confirming the same hold twice books the seats
  exactly once. Confirming an expired/unknown hold fails and books nothing.
- **Exact inventory** — `available + held(active) + booked` always equals 50.
- **Real-time** — every seat transition (held / booked / released) is broadcast
  over SSE so all clients stay in sync.

## Running

```bash
npm install

# Run backend (port 3001) and frontend dev server (port 5173) together:
npm run dev

# Or individually:
npm run server   # Express + PGLite on :3001
npm run client   # Vite dev server on :5173 (proxies /api -> :3001)
```

Open http://localhost:5173.

Configuration via env vars:

- `PORT` — backend port (default `3001`)
- `HOLD_TTL_MS` — hold time-to-live in ms (default `60000`)

## API

| Method | Path                          | Description                                   |
|--------|-------------------------------|-----------------------------------------------|
| GET    | `/api/seats`                  | Effective seat map (expired holds reported available) |
| GET    | `/api/inventory`              | `{ available, held, booked }` counts          |
| POST   | `/api/holds`                  | `{ seatIds, sessionId }` → atomic hold or 409 |
| POST   | `/api/holds/:holdId/confirm`  | Book the hold's seats (idempotent)            |
| DELETE | `/api/holds/:holdId`          | Release a hold early                          |
| GET    | `/api/stream`                 | SSE stream of seat-status transitions         |

## How correctness is guaranteed

- **Atomicity**: all seat-mutating operations run through a single in-process
  serialization chain and a SQL transaction. Seat acquisition uses a conditional
  `UPDATE ... WHERE status='available'` and verifies the affected-row count
  equals the request size; any shortfall rolls the whole hold back.
- **Expiry**: `expires_at` is computed on the server. Stale holds are released
  before every read and every hold/confirm, plus a 5s periodic sweep — clients
  are never trusted to free inventory.
- **Idempotency**: confirm checks the hold's status; an already-`confirmed` hold
  returns its existing booking without re-booking.
