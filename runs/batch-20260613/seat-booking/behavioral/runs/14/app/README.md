# Seat Booking

A concurrency-safe seat-booking / ticketing service for a single event with a
fixed seat map. Built on an embedded **PGLite** database with a **Node.js /
Express** backend and a **Vanilla JS (Vite)** frontend. Seat-status changes are
pushed live to every client via **Server-Sent Events**.

## Capabilities

- Fixed seat map (5 rows × 10 seats) persisted in PGLite.
- **Atomic hold-with-TTL**: a request for N seats acquires *all or none*. Two
  concurrent requests for the same seat: exactly one wins; the loser gets a 409
  with the conflicting seat ids and acquires nothing.
- **Idempotent confirmation**: confirming a hold books its seats exactly once;
  repeated confirms (retries/double-clicks) return the same booking and book
  nothing additional.
- **Automatic expiry**: holds past their TTL are released on every read, before
  every hold/confirm, and by a periodic sweep — no manual action needed.
- **Exact inventory**: `available + held(active) + booked == total` always.
- **Real-time**: every `held` / `booked` / `released` transition is broadcast
  over SSE so all seat maps converge.

## Running

```bash
npm install
npm run dev        # backend (3001) + Vite dev server (5173) together
# or, production-style:
npm run build && npm start   # serves built client from the API server
```

Environment:
- `PORT` (default `3001`)
- `DATA_DIR` (default `./data/pgdata`)
- `HOLD_TTL_MS` (default `120000`)

## API

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/api/seats` | Full seat map with effective status (expired holds shown available). |
| GET    | `/api/summary` | Inventory counts. |
| POST   | `/api/holds` | Body `{ seatIds, sessionId }`. 201 hold, or 409 `{ conflicts }`. |
| POST   | `/api/holds/:holdId/confirm` | Book the held seats (idempotent). |
| DELETE | `/api/holds/:holdId` | Release a hold early. |
| GET    | `/api/stream` | SSE stream of seat-change events. |

## Concurrency model

PGLite runs queries on a single connection; the server additionally serializes
all write operations through an internal promise chain. Each hold acquires its
seats with a single conditional `UPDATE` that only flips seats which are
*effectively available* (available, or held-but-expired) and verifies the
affected-row count equals the request size — otherwise the whole transaction
rolls back. This guarantees the all-or-nothing property even under heavy
concurrent load. Confirmation re-validates ownership and expiry inside the
transaction and short-circuits to the existing booking when already confirmed.

## Tests

```bash
npm test
```

Tests cover: atomic all-or-nothing holds, the single-winner property under 50
concurrent requests for one seat, blocking by active holds, automatic expiry and
re-holding, early release, idempotent and concurrent confirms, rejection of
expired/unknown confirms, inventory reconciliation, the periodic sweep, and the
HTTP + SSE surface end to end.
