# Seat Booking

A greenfield single-event seat booking app with a Node/Express backend, embedded PGLite persistence, all-or-nothing temporary holds, idempotent confirmation, automatic expiry, exact inventory counts, and live Server-Sent Events updates.

## Run

```bash
npm install
npm run dev
```

- Backend API: http://localhost:3000
- Frontend: http://localhost:5173

## API

- `GET /api/seats` — sweeps expired holds, then returns seats plus inventory.
- `POST /api/holds` — body `{ "seatIds": ["A-1"], "sessionId": "client-session" }`; atomically holds all requested seats or returns `409` with `conflicts` and holds none.
- `POST /api/holds/:holdId/confirm` — body `{ "sessionId": "client-session" }`; transactionally books an active hold. Repeated confirmation is idempotent and returns the original booking.
- `DELETE /api/holds/:holdId` — body/query `sessionId`; releases an active hold early.
- `GET /api/stream` — SSE stream broadcasting `seat-update` events for held, booked, released, and expired seats.

The default map is 5 rows × 10 seats. Default hold TTL is 30 seconds and can be changed with `HOLD_TTL_MS`.
