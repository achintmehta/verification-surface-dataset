# Seat Booking

A real-time seat-booking / ticketing service for a single event with a fixed seat map.

## Architecture

- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL via WASM)
- **Frontend**: Vanilla JS SPA served by Vite
- **Real-time**: Server-Sent Events (SSE) push seat-status changes to all connected clients

## Features

- Fixed 5×10 seat map (rows A–E, seats 1–10)
- Atomic hold acquisition: all-or-nothing, 409 on conflict
- 60-second hold TTL with server-enforced expiry
- Idempotent confirmation: repeated confirms book exactly once
- Automatic hold expiry via lazy evaluation + periodic sweep (every 5s)
- Real-time seat-status broadcasting via SSE
- Exact inventory: available + held(active) + booked = total seats at all times

## Getting Started

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001/api

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/seats` | List all seats with current effective status |
| POST | `/api/holds` | Place a hold on one or more seats |
| POST | `/api/holds/:holdId/confirm` | Confirm (book) a hold |
| DELETE | `/api/holds/:holdId` | Release a hold early |
| GET | `/api/stream` | SSE stream of seat status changes |
| GET | `/api/health` | Health check |

### POST /api/holds

```json
{ "seatIds": ["A1", "A2"], "sessionId": "uuid" }
```

Returns `201` with `{ holdId, seatIds, expiresAt, ttlSeconds }` or `409` with `{ conflictingSeatIds }`.

### POST /api/holds/:holdId/confirm

```json
{ "sessionId": "uuid" }
```

Returns `200` with booking details. Idempotent.

### DELETE /api/holds/:holdId

```json
{ "sessionId": "uuid" }
```

Returns `200` on success.

## SSE Events

| Event | Payload |
|-------|---------|
| `seat:held` | `{ seatId, status, holdId, holdExpiresAt }` |
| `seat:booked` | `{ seatId, status, holdId, bookedBy }` |
| `seat:released` | `{ seatId, status }` |

## Concurrency Guarantees

- Hold requests run inside a PostgreSQL transaction with `SELECT ... FOR UPDATE` to prevent two concurrent requests from acquiring the same seat.
- Confirm requests re-validate hold ownership and expiry inside a transaction before booking.
- Expiry is enforced on every read and before every hold/confirm operation, plus a periodic sweep.
- PGLite serializes all operations (single-process embedded WASM PostgreSQL), providing strong consistency.
