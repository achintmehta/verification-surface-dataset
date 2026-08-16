# Seat Booking

A greenfield seat-booking/ticketing demo with a Node.js/Express backend, embedded PGLite persistence, transactional hold/confirm/release logic, automatic hold expiry, and Server-Sent Events for live seat-map updates.

## Run

```bash
npm install
npm run dev
```

- Backend: http://localhost:3000
- Frontend: http://localhost:5173

## API

- `GET /api/seats` — returns all seats after lazily expiring stale holds.
- `POST /api/holds` with `{ "seatIds": ["A-1"], "sessionId": "client-session" }` — atomically holds all requested seats or returns `409` with conflicts.
- `POST /api/holds/:holdId/confirm` with `{ "sessionId": "client-session" }` — confirms an active hold idempotently.
- `DELETE /api/holds/:holdId` — releases an active hold early.
- `GET /api/stream` — SSE stream broadcasting `seat-update` events.

Data persists in `./.pglite` by default. Set `PGLITE_DATA_DIR` or `HOLD_TTL_MS` to override the storage path or hold TTL.
