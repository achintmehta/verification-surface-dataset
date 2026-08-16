# Seat Booking

A real-time seat-booking / ticketing service for a single event with a fixed seat map.

## Architecture

- **Backend**: Node.js + Express + PGlite (embedded PostgreSQL)
- **Frontend**: Vanilla JS SPA served by Vite
- **Real-time**: Server-Sent Events (SSE) for live seat-status updates

## Features

- Fixed seat map (5 rows × 10 seats = 50 seats)
- Atomic hold acquisition with TTL (60 seconds)
- All-or-nothing hold: if any requested seat is unavailable, none are held
- Idempotent confirmation: confirming the same hold twice books seats exactly once
- Auto-expiry: held seats are released after TTL without manual action
- Real-time broadcast of every seat status transition to all connected clients
- Exact inventory: available + held + booked always equals total seats

## Getting Started

```bash
# Install dependencies
npm install

# Run both backend and frontend in development mode
npm run dev
```

- Backend: http://localhost:3001
- Frontend: http://localhost:5173

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/seats | List all seats with current status |
| POST | /api/holds | Place a hold on one or more seats |
| POST | /api/holds/:holdId/confirm | Confirm (book) a hold |
| DELETE | /api/holds/:holdId | Release a hold early |
| GET | /api/stream | SSE stream for real-time updates |
| GET | /api/health | Health check |

### POST /api/holds

```json
{
  "seatIds": ["A1", "A2"],
  "sessionId": "your-session-uuid"
}
```

Returns `201` with hold details, or `409` with `conflicts` array if any seat is unavailable.

### POST /api/holds/:holdId/confirm

```json
{
  "sessionId": "your-session-uuid"
}
```

Returns `200` on success, `410` if hold is expired/released, `404` if not found.

### DELETE /api/holds/:holdId

```json
{
  "sessionId": "your-session-uuid"
}
```

## Concurrency Guarantees

- Seat acquisition uses `SELECT ... FOR UPDATE` inside a transaction
- PGlite serializes all operations, preventing race conditions
- Expired holds are swept on every read and before every hold/confirm operation
- A background sweep runs every 5 seconds to release stale holds
