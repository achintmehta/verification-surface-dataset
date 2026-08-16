# Seat Booking

A real-time seat-booking / ticketing service for a single event with a fixed seat map.

## Architecture

- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL)
- **Frontend**: Vanilla JS + Vite
- **Real-time**: Server-Sent Events (SSE)

## Features

- Fixed seat map (5 rows × 10 seats = 50 seats)
- Atomic hold acquisition (all-or-nothing, 409 on conflict)
- 60-second hold TTL with automatic expiry
- Idempotent confirmation
- Real-time seat status via SSE
- Exact inventory accounting

## Getting Started

```bash
# Install dependencies
npm install

# Run both server and client in development mode
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/seats | List all seats with current status |
| POST | /api/holds | Create a hold `{ seatIds, sessionId }` |
| POST | /api/holds/:id/confirm | Confirm a hold `{ sessionId }` |
| DELETE | /api/holds/:id | Release a hold `{ sessionId }` |
| GET | /api/stream | SSE stream of seat-status events |
| GET | /api/health | Health check |

## Concurrency Guarantees

All seat mutations run through a serialised promise queue on the single PGLite
connection, with `FOR UPDATE` row locks inside transactions. This ensures:

- No two requests can acquire the same seat simultaneously
- Expired holds are released atomically before any new hold is created
- Confirmation is idempotent – a second confirm returns the same result
