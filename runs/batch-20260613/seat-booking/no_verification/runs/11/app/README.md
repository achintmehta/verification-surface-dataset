# Seat Booking

A concurrency-safe seat-booking / ticketing service for a single event with a
fixed seat map. Built with a Node.js + Express backend, **embedded PGLite** for
raw SQL/transactions, and a Vanilla-JS / Vite frontend kept live with
**Server-Sent Events**.

## Features

- Fixed seat map (5 rows × 10 seats = 50 seats) persisted to local disk.
- **Atomic hold acquisition**: requesting N seats is all-or-nothing. Two
  concurrent requests for the same seat can never both succeed; the loser gets a
  `409` with the conflicting seat ids.
- **Hold TTL** (60s) with **server-side expiry** enforced on every read and
  before every hold/confirm, plus a periodic sweep.
- **Idempotent confirmation**: confirming the same hold twice books exactly once.
- **Exact inventory**: available + held(active) + booked always equals total.
- **Real-time**: every seat transition (held / booked / released) is pushed to
  all connected clients over SSE.

## Getting started

```bash
npm install        # installs backend + frontend deps
npm run dev        # runs backend (:3001) and Vite dev server (:5173)
```

Open http://localhost:5173. Open it in two browser windows (use **New session**
in one) to watch holds/bookings sync live between them.

To run the backend alone: `npm start` (serves the API on `:3001`).

## API

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET`  | `/api/seats` | All seats with effective status (expired holds reported available). |
| `GET`  | `/api/inventory` | `{ available, held, booked, total }`. |
| `POST` | `/api/holds` | Body `{ seatIds, sessionId }`. Atomically holds all seats or `409 { conflicts }`. |
| `POST` | `/api/holds/:holdId/confirm` | Books the hold's seats (idempotent). |
| `DELETE` | `/api/holds/:holdId` | Releases a hold early. |
| `GET`  | `/api/stream` | SSE stream of seat-status changes. |

## Concurrency model

All state-mutating operations and reads are funneled through a process-local
async mutex (`withLock`) so the check-and-set critical section runs to
completion before the next operation begins. The acquisition itself is also
guarded inside a SQL transaction with a conditional `UPDATE ... WHERE status =
'available'` that returns the affected rows; if fewer than requested were
grabbed the whole transaction is rolled back. PGLite is a single embedded
Postgres instance, so this guarantees no seat is ever double-held or
double-booked.
