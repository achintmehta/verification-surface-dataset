# Seat Booking

A single-event seat-booking / ticketing service with strict correctness under
concurrency. Users place temporary **holds** on seats, then **confirm** holds to
**book** them. Built on a Node.js + Express backend with embedded **PGLite**
(PostgreSQL-in-process) and **Server-Sent Events (SSE)** for live seat maps. The
frontend is a Vanilla JS SPA bundled with Vite.

## Guarantees

- **Atomic, all-or-nothing holds.** A hold over N seats succeeds only if *every*
  requested seat is currently available; otherwise none are acquired and the
  request returns `409` with the conflicting seat ids.
- **No double-booking.** Seat acquisition runs inside a serialized PGLite
  transaction with `SELECT … FOR UPDATE`; under concurrent requests for the same
  seat exactly one succeeds.
- **TTL expiry.** Each hold stores `expires_at = now + TTL`. Expiry is enforced
  lazily on every seat read and before every hold/confirm/release operation, plus
  a periodic background sweep. Expired holds release their seats automatically.
- **Idempotent confirmation.** Confirming the same hold twice books the seats
  exactly once and returns the same booking.
- **Exact inventory.** `available + held(active) + booked == total` at all times.
- **Live updates.** Every transition (held / booked / released) is broadcast over
  SSE so all connected seat maps converge.

## Project layout

```
server/
  config.js   seat-map size, TTL, ports
  db.js       PGLite init, seed, write serialization lock
  seats.js    atomic hold/confirm/release/expiry logic + broadcast hooks
  sse.js      SSE client registry + broadcast
  index.js    Express app + routes + startup
client/
  index.html, style.css, main.js   Vanilla JS seat-map SPA
vite.config.js                     dev proxy /api -> backend
```

## API

| Method | Path                          | Description                                            |
|--------|-------------------------------|--------------------------------------------------------|
| GET    | `/api/seats`                  | All seats with effective (expiry-aware) status         |
| GET    | `/api/inventory`              | `{ available, held, booked, total }`                   |
| POST   | `/api/holds`                  | `{ seatIds, sessionId }` → hold; `409` on conflict     |
| POST   | `/api/holds/:holdId/confirm`  | `{ sessionId }` → booking (idempotent)                 |
| DELETE | `/api/holds/:holdId`          | release a hold early                                   |
| GET    | `/api/stream`                 | SSE stream of seat transitions                         |

## Running

```bash
npm install
npm run dev        # backend (:3001) + Vite frontend (:5173) together
```

Or run pieces separately:

```bash
npm run server     # Express + PGLite on :3001
npm run client     # Vite dev server on :5173 (proxies /api to :3001)
```

Open http://localhost:5173. Open it in multiple tabs/windows to watch holds and
bookings propagate live.

## Configuration (env vars)

- `PORT` (default `3001`)
- `DB_DIR` (default `./server/.pgdata`)
- `HOLD_TTL_MS` (default `60000`)
- `SWEEP_INTERVAL_MS` (default `5000`)
