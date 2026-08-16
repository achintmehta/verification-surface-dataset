# Seat Booking Service

A seat-booking / ticketing service for a single event with a fixed seat map.

## Architecture

- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL)
- **Frontend**: Vanilla JS + Vite
- **Real-time**: Server-Sent Events (SSE)

## Features

- Fixed seat map (5 rows × 10 seats = 50 seats)
- Atomic hold acquisition (all-or-nothing, 409 on conflict)
- Hold TTL with automatic expiry (default: 60 seconds)
- Idempotent confirmation
- Real-time seat status via SSE
- Exact inventory accounting under concurrency

## Development

```bash
# Install dependencies
npm install

# Run backend + frontend concurrently
npm run dev

# Backend only (port 3001)
npm run dev --workspace=server

# Frontend only (port 5173)
npm run dev --workspace=client
```

## Testing

```bash
npm test
```

## API

### `GET /api/seats`
Returns all seats with current effective status.

### `POST /api/holds`
```json
{ "seatIds": ["A1", "A2"], "sessionId": "uuid" }
```
Creates a hold. Returns 409 if any seat is unavailable.

### `POST /api/holds/:holdId/confirm`
```json
{ "sessionId": "uuid" }
```
Confirms a hold, booking the seats. Idempotent.

### `DELETE /api/holds/:holdId`
```json
{ "sessionId": "uuid" }
```
Releases a hold early.

### `GET /api/stream`
SSE endpoint. Emits `seatUpdate` events with `{ type, seats }`.
