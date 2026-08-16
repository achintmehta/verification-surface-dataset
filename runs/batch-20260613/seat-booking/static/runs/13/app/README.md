# Live Seat Booking

A concurrency-correct seat-booking / ticketing service for a single event with a
fixed seat map. Users place temporary **holds** on seats (with a TTL), then
**confirm** holds to book them. The system guarantees no seat is booked by two
sessions, auto-expires abandoned holds, keeps inventory exact, and pushes every
seat-status transition to all viewers via **Server-Sent Events**.

## Stack

- **Backend:** Node.js + Express, embedded **PGLite** (raw SQL + transactions),
  persisting seat state to local disk.
- **Realtime:** Server-Sent Events (`GET /api/stream`).
- **Frontend:** Vanilla JS SPA built with Vite, rendering an interactive seat grid.

## Getting started

```bash
npm install
npm run dev      # runs backend (:3001) and Vite frontend (:5173) together
```

Or run separately:

```bash
npm run dev:server   # Express + PGLite on :3001
npm run dev:client   # Vite dev server on :5173 (proxies /api -> :3001)
```

Production-style serving of the API only:

```bash
npm start
```

## Concurrency model

- **Atomic acquisition (Decision 1):** `POST /api/holds` runs in a PGLite
  transaction. Requested seats are locked with `SELECT ... FOR UPDATE`, checked
  for availability all-or-nothing, then marked `held`. Two concurrent requests
  for the same seat are serialized; the loser acquires *none* of its seats and
  receives `409` with the conflicting seat ids.
- **Time-based expiry (Decision 2):** every hold has a server-computed
  `expires_at`. Expired holds are released lazily on every read and at the start
  of every hold/confirm/release transaction, plus a periodic sweep. Releases are
  broadcast over SSE.
- **Idempotent confirmation (Decision 3):** `POST /api/holds/:id/confirm`
  re-validates existence, ownership and expiry inside the transaction. A second
  confirm of an already-confirmed hold returns the same booking and books
  nothing more. Expired/unknown holds fail and book nothing.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/seats` | Full seat map with effective status (expired holds shown as available). |
| `GET` | `/api/inventory` | Exact counts: `available + held + booked == total`. |
| `POST` | `/api/holds` | Body `{ seatIds, sessionId }`. Atomic all-or-nothing hold; `409` with `conflicts` on failure. |
| `GET` | `/api/holds/:holdId` | Current hold state and remaining TTL. |
| `POST` | `/api/holds/:holdId/confirm` | Idempotently books the hold's seats. |
| `DELETE` | `/api/holds/:holdId` | Releases a hold early; seats become available. |
| `GET` | `/api/stream` | SSE stream of `seats` events with changed seat rows. |

## Seat schema

`seats(id, row_label, seat_number, status[available|held|booked], hold_id,
hold_expires_at, booked_by)` seeded with a fixed map (default 5 rows × 10 seats).
