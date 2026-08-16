# 🎟️ Seat Booking

A concurrency-safe seat-booking / ticketing service for a single event with a
fixed seat map. Built on an embedded **PGLite** PostgreSQL database, an
**Express** API, **Server-Sent Events** for live updates, and a lightweight
**Vanilla JS + Vite** frontend.

## Features

- Fixed seat map (5 rows × 10 seats) persisted in PGLite on local disk.
- **Atomic holds**: a hold request acquires *all* requested seats or *none*
  (all-or-nothing). Concurrent requests for the same seat can never both win;
  the loser gets a `409` with the conflicting seat ids.
- **Hold TTL**: each hold has a server-computed `expires_at` (default 60s).
- **Idempotent confirmation**: confirming the same hold twice books the seats
  exactly once.
- **Auto-expiry**: expired holds are released lazily on every read/operation and
  by a periodic sweep — seats become available again with no manual action.
- **Exact inventory**: `available + held(active) + booked === total` at all times.
- **Live updates**: every transition (held / booked / released) is broadcast via
  SSE so all connected seat maps stay in sync.

## Getting started

```bash
npm install

# Run backend + frontend together (dev)
npm run dev

# Or separately
npm run dev:server   # Express + PGLite on :3001
npm run dev:client   # Vite dev server on :5173 (proxies /api -> :3001)
```

Open the Vite dev URL (http://localhost:5173). The dev server proxies `/api`
requests to the backend.

### Production-style

```bash
npm run build        # builds the SPA into dist/
npm start            # serves API + built SPA from :3001
```

## API

| Method | Path                          | Description                                            |
| ------ | ----------------------------- | ----------------------------------------------------- |
| GET    | `/api/seats`                  | All seats with effective status + counts.             |
| POST   | `/api/holds`                  | `{ seatIds, sessionId }` → atomic hold (201) or 409.  |
| POST   | `/api/holds/:holdId/confirm`  | Book the hold's seats (idempotent).                   |
| DELETE | `/api/holds/:holdId`          | Release a hold early.                                 |
| GET    | `/api/stream`                 | SSE stream of seat-status transitions.                |

## Configuration

- `PORT` — backend port (default `3001`).
- `HOLD_TTL_MS` — hold lifetime in ms (default `60000`).
- `PGLITE_DIR` — PGLite data directory (default `./data/pgdata`).

## Correctness notes

- All write operations (hold / confirm / release / sweep) are serialized through
  an in-process mutex and run inside `BEGIN … COMMIT` transactions with
  `SELECT … FOR UPDATE` on the affected seats, guaranteeing atomic check-and-set
  semantics under concurrency.
- Expiry is enforced **server-side** on every read and before every operation;
  client timers are advisory only.
