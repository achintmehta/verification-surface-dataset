# Seat Booking

A greenfield single-event seat-booking application with:

- Express backend
- Embedded PGLite persistence
- Atomic all-or-nothing seat holds with server-side TTL
- Idempotent hold confirmation
- Lazy and periodic hold expiry
- Server-Sent Events seat-status broadcasts
- Vanilla JS / Vite frontend

## Scripts

```bash
npm run dev      # run API and Vite dev server
npm run server   # run API only on PORT=3001 by default
npm run client   # run Vite only
npm run build    # build frontend into dist/
npm start        # serve API and built frontend
npm test         # syntax checks
```

## API

- `GET /api/seats` returns all seats and inventory totals after sweeping expired holds.
- `POST /api/holds` with `{ "seatIds": [1,2], "sessionId": "abc" }` atomically acquires all requested seats or returns `409` with `conflictSeatIds`.
- `POST /api/holds/:holdId/confirm` with `{ "sessionId": "abc" }` books an active hold. Repeating the request is idempotent.
- `DELETE /api/holds/:holdId` with `{ "sessionId": "abc" }` releases an active hold early.
- `GET /api/stream` streams `seats` events containing changed seats.

Configuration is via environment variables: `PORT`, `PGLITE_DATA_DIR`, `HOLD_TTL_SECONDS`, and `SWEEP_INTERVAL_MS`.
