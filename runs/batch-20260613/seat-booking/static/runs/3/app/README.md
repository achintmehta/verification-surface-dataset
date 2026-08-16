# Seat Booking

A real-time seat-booking / ticketing service for a single event with a fixed seat map.

## Architecture

- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL)
- **Frontend**: Vanilla JS + Vite
- **Real-time**: Server-Sent Events (SSE)

## Features

- Fixed seat map (5 rows × 10 seats = 50 seats)
- Atomic hold acquisition (all-or-nothing, 60-second TTL)
- Transactional, idempotent confirmation
- Automatic hold expiry (lazy + periodic sweep)
- Real-time seat-status broadcasting via SSE
- Exact inventory accounting under concurrency

## Getting Started

```bash
# Install all dependencies
npm install

# Run backend + frontend concurrently
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/seats` | List all seats with effective status |
| POST | `/api/holds` | Place a hold `{ seatIds, sessionId }` |
| POST | `/api/holds/:id/confirm` | Confirm a hold `{ sessionId }` |
| DELETE | `/api/holds/:id` | Release a hold `{ sessionId }` |
| GET | `/api/stream` | SSE stream of seat-status events |
| GET | `/api/health` | Health check |

## Concurrency Guarantees

- All seat mutations go through a serialising mutex (PGLite single-writer model)
- Hold acquisition uses an atomic transaction with a post-write verification step
- Expired holds are released before every read and write operation
- Confirmation is idempotent: repeated confirms return the same result
