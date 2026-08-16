# Seat Booking Service

A seat-booking / ticketing service for a single event with a fixed seat map.

## Architecture

- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL)
- **Frontend**: Vanilla JS + Vite
- **Real-time**: Server-Sent Events (SSE)

## Features

- Fixed seat map (5 rows × 10 seats = 50 seats)
- Atomic hold acquisition (all-or-nothing, 409 on conflict)
- Hold TTL: 60 seconds
- Idempotent confirmation
- Automatic hold expiry (lazy sweep + periodic sweep every 10s)
- Real-time seat status via SSE
- Exact inventory accounting

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

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/seats | List all seats with current status |
| POST | /api/holds | Create a hold (all-or-nothing) |
| POST | /api/holds/:id/confirm | Confirm a hold (idempotent) |
| DELETE | /api/holds/:id | Release a hold early |
| GET | /api/stream | SSE stream for real-time updates |

## Seat Status Flow

```
available → held (POST /api/holds)
held → booked (POST /api/holds/:id/confirm)
held → available (DELETE /api/holds/:id or TTL expiry)
```
