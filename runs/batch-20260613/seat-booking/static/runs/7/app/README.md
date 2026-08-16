# Seat Booking

A small client-server seat-booking application using Express, embedded PGLite, Server-Sent Events, and a Vanilla JS/Vite frontend.

## Run

```bash
npm install
npm run dev
```

- Backend API: http://localhost:3000
- Frontend: http://localhost:5173

## API

- `GET /api/seats` - full seat map and inventory after lazy expiry sweep.
- `POST /api/holds` - `{ "seatIds": ["A-1"], "sessionId": "..." }`, atomically holds all requested seats or returns `409` with `conflictSeatIds`.
- `POST /api/holds/:holdId/confirm` - `{ "sessionId": "..." }`, confirms an active hold; repeated confirmation is idempotent.
- `DELETE /api/holds/:holdId` - `{ "sessionId": "..." }`, releases an active hold early.
- `GET /api/stream` - SSE seat status transitions.
