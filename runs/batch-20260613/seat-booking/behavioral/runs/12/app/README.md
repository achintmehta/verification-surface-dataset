# Live Seat Booking

A single-event seat-booking / ticketing service with strict correctness under
concurrency. Built on a Node.js + Express backend with **embedded PGLite** for
raw SQL and transactions, a **Vanilla JS / Vite** frontend, and **Server-Sent
Events** keeping every seat map live.

## Guarantees

- **Atomic acquisition** — a hold request acquires *all* requested seats or
  *none* (409 with the conflicting seat ids). Under many concurrent requests for
  the same seat, exactly one wins.
- **TTL expiry** — every hold has a server-computed `expires_at`. Expired holds
  are released lazily before every read/write and by a periodic sweep; clients
  are notified via SSE.
- **Idempotent confirmation** — confirming the same hold twice books its seats
  exactly once. Confirming an expired/unknown hold fails and books nothing.
- **Exact inventory** — `available + held(active) + booked == total` at all times.
- **No double-booking** — a seat is never booked by two different sessions.

## Layout

```
server/        Express API + PGLite + booking logic + SSE
  config.js    seat map size, TTL, ports
  db.js        schema + fixed seat-map seeding
  booking.js   BookingService: holds, confirm, release, expiry (serialised)
  sse.js       SSE broadcast hub
  index.js     Express wiring + background sweep + server bootstrap
client/        Vanilla JS SPA (Vite)
  index.html, style.css, main.js
test/          node:test suites (unit + HTTP + concurrency)
```

## Run

```bash
npm install
npm run dev      # backend (:3000) + Vite frontend (:5173) together
# or separately:
npm run dev:server
npm run dev:client
```

The Vite dev server proxies `/api` to the backend. For production, `npm run build`
emits the SPA to `dist/`.

## API

| Method | Path                         | Description                                  |
| ------ | ---------------------------- | -------------------------------------------- |
| GET    | `/api/seats`                 | Full seat map with effective status          |
| POST   | `/api/holds`                 | `{ seatIds, sessionId }` → all-or-nothing hold |
| POST   | `/api/holds/:holdId/confirm` | Confirm (idempotent) → books the seats       |
| DELETE | `/api/holds/:holdId`         | Release a hold early                         |
| GET    | `/api/stream`                | SSE stream of seat transitions               |

## Tests

```bash
npm test
```

Covers seeding, hold/confirm/release, lazy + swept expiry, idempotency,
ownership, and heavy concurrency (50 simultaneous requests for one seat → exactly
one winner; overlapping multi-seat requests stay all-or-nothing; inventory always
reconciles).
