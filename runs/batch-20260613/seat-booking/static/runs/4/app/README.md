# Seat Booking

A real-time seat-booking / ticketing service for a single event with a fixed seat map.

## Architecture

- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL)
- **Frontend**: Vanilla JS SPA served by Vite
- **Real-time**: Server-Sent Events (SSE)

## Features

- Fixed 5×10 seat map (rows A–E, seats 1–10)
- Atomic all-or-nothing hold acquisition (no double-booking)
- 60-second hold TTL with automatic expiry
- Idempotent hold confirmation
- Real-time seat-status updates via SSE
- Exact inventory accounting at all times

## Getting Started

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/seats` | List all seats with effective status |
| POST | `/api/holds` | Create a hold `{ seatIds, sessionId }` |
| POST | `/api/holds/:id/confirm` | Confirm a hold `{ sessionId }` |
| DELETE | `/api/holds/:id` | Release a hold `{ sessionId }` |
| GET | `/api/stream` | SSE stream of seat-status events |

## SSE Events

| Event | Payload |
|-------|---------|
| `seats_held` | `{ holdId, seatIds, sessionId, expiresAt }` |
| `seats_booked` | `{ holdId, seatIds, sessionId }` |
| `seats_released` | `{ holdId, seatIds, reason }` |
