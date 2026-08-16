# Seat Booking

A real-time seat-booking / ticketing service for a single event.

## Architecture

- **Backend**: Node.js + Express + PGLite (embedded Postgres, persisted to `./data/pglite`)
- **Frontend**: Vanilla JS SPA served by Vite
- **Real-time**: Server-Sent Events (SSE) push every seat-status change to all connected clients

## Quick Start

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/seats` | Full seat map with effective status |
| POST | `/api/holds` | Atomic all-or-nothing hold (`{ seatIds, sessionId }`) |
| POST | `/api/holds/:id/confirm` | Idempotent confirmation (`{ sessionId }`) |
| DELETE | `/api/holds/:id` | Early hold release (`{ sessionId }`) |
| GET | `/api/stream` | SSE event stream |

## SSE Events

| Event | Payload |
|-------|---------|
| `seats:held` | `{ holdId, expiresAt, seats[] }` |
| `seats:booked` | `{ holdId, seats[] }` |
| `seats:released` | `{ seats[] }` |

## Seat Map

5 rows (A–E) × 10 seats = 50 seats total.  
Hold TTL: 60 seconds.

## Concurrency Guarantees

- Seat acquisition uses `SELECT … FOR UPDATE` inside a transaction → no double-holds.
- Confirmation re-validates hold ownership and expiry inside the same transaction.
- Expired holds are swept lazily on every read and by a 5-second background worker.
