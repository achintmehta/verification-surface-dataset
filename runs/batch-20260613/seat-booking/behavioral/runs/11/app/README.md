# Seat Booking

A concurrency-correct seat-booking / ticketing service for a single event,
built on an embedded **PGLite** database with **Server-Sent Events** keeping
every connected seat map live.

## Architecture

```
client/            Vanilla JS + Vite single-page app (interactive seat map)
server/
  config.js        Seat map dimensions, hold TTL, ports
  db.js            PGLite init + schema + fixed seat-map seeding
  booking.js       Core transactional logic (holds / confirm / release / expiry)
  sse.js           SSE connection hub + broadcaster
  app.js           Express app wiring routes to the BookingService
  index.js         Server entrypoint (PGLite -> Express -> listen)
test/              node:test suites covering concurrency & inventory invariants
```

## Correctness model

- **Atomic acquisition** — a hold acquires *all* requested seats or *none*.
  Acquisition uses a conditional `UPDATE ... WHERE status='available'` inside a
  transaction; if the affected-row count doesn't match the request, the whole
  transaction rolls back and the caller gets `409` with the conflicting seat ids.
- **Serialized mutations** — every mutating operation runs through an internal
  promise queue so "expire stale holds + acquire" executes as one critical
  section. Combined with the conditional update, two concurrent requests can
  never both win the same seat.
- **Server-side expiry** — each hold stores `expires_at = now + TTL`. Stale
  holds are released lazily on every read and before every mutation, plus a
  periodic background sweep. Clients never free inventory on their own.
- **Idempotent confirm** — confirming an already-confirmed hold returns the same
  booking and books nothing more. Confirming an expired/unknown hold fails and
  books nothing.
- **Exact inventory** — `available + held(active) + booked == total` always.

## Run

```bash
npm install
npm run dev      # backend (:3000) + Vite frontend (:5173) together
# or separately:
npm run dev:server
npm run dev:client
```

Production build of the frontend:

```bash
npm run build && npm run preview
```

## API

| Method | Path                          | Description |
|--------|-------------------------------|-------------|
| GET    | `/api/seats`                  | All seats + inventory (expiry applied) |
| GET    | `/api/inventory`              | `{ available, held, booked, total }` |
| POST   | `/api/holds`                  | `{ seatIds, sessionId }` → hold (all-or-nothing, 409 on conflict) |
| POST   | `/api/holds/:id/confirm`      | Book the hold's seats (idempotent) |
| DELETE | `/api/holds/:id`              | Release a hold early |
| GET    | `/api/stream`                 | SSE stream of seat-status changes |

## Tests

```bash
npm test
```

Covers single-winner contention, all-or-nothing holds, TTL expiry,
idempotent confirmation, release, and the inventory-balance invariant.
