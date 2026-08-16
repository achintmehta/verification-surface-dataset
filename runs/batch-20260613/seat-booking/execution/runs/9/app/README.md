# Seat Booking

A traditional client-server seat-booking application using Express, embedded PGLite, and a vanilla Vite frontend. It supports atomic all-or-nothing seat holds, hold expiry, idempotent confirmation, early release, exact inventory counts, and live seat updates through Server-Sent Events.

## Run

```bash
npm install
npm run dev
```

- Backend API: http://localhost:3000
- Frontend: Vite's printed URL, usually http://localhost:5173

For a production-style single server:

```bash
npm run build
NODE_ENV=production npm start
```

## API

- `GET /api/seats` returns all seats and inventory. Expired holds are swept before the response.
- `POST /api/holds` with `{ "seatIds": ["A1"], "sessionId": "client-1" }` atomically holds every requested available seat or returns `409` with conflicts.
- `POST /api/holds/:holdId/confirm` with `{ "sessionId": "client-1" }` books an active hold. Repeating the call is idempotent.
- `DELETE /api/holds/:holdId` releases an active hold early.
- `GET /api/stream` streams `seats` events for held/booked/released transitions.

## Configuration

- `PORT` backend port, default `3000`.
- `PGLITE_DATA_DIR` database directory, default `data/pglite`.
- `HOLD_TTL_SECONDS` hold TTL, default `60`.
- `VITE_API_BASE` frontend API base, default `http://localhost:3000`.
