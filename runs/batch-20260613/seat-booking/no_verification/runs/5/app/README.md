# Seat Booking

A real-time seat-booking / ticketing service for a single event with a fixed seat map.

## Architecture

- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL, persisted to `./data/pglite`)
- **Frontend**: Vanilla JS SPA served by Vite in development
- **Real-time**: Server-Sent Events (SSE) push every seat-status transition to all connected clients

## Features

- Fixed seat map: 5 rows (A–E) × 10 seats = 50 seats
- **Hold flow**: atomically acquire one or more seats with a 60-second TTL
- **Confirm flow**: idempotent confirmation books seats permanently
- **Auto-expiry**: stale holds are released lazily on every read and by a 10-second background sweep
- **Concurrency safety**: a serialization mutex ensures no two hold/confirm operations overlap in PGLite
- **All-or-nothing**: if any requested seat is unavailable, no seats are held (returns 409 with conflicting IDs)
- **SSE broadcast**: every `held`, `booked`, and `released` transition is pushed to all clients

## Getting Started

```bash
# Install dependencies
npm install

# Development (backend on :3001, frontend on :5173 with proxy)
npm run dev

# Production build + serve
npm run build
npm start
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/seats` | List all seats with current effective status |
| `POST` | `/api/holds` | Place a hold: `{ seatIds, sessionId }` |
| `POST` | `/api/holds/:holdId/confirm` | Confirm a hold: `{ sessionId }` |
| `DELETE` | `/api/holds/:holdId` | Release a hold early: `{ sessionId }` |
| `GET` | `/api/stream` | SSE stream of seat-status events |
| `GET` | `/api/health` | Health check |

## Seat Status Transitions

```
available ──hold──► held ──confirm──► booked
    ▲                │
    └──release/TTL───┘
```

## Concurrency Guarantees

1. All mutating operations (hold, confirm, release) are serialized through an async mutex.
2. The `UPDATE … WHERE status = 'available'` guard inside the hold operation provides a second layer of protection: even if two requests pass the initial availability check, only one will successfully update all seats.
3. Confirmation re-validates hold existence, ownership, and expiry inside the same serialized operation before booking.
