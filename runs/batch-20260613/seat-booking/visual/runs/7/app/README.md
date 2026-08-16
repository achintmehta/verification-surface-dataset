# Seat Booking

A single-event seat-booking web application with a Node/Express backend, embedded PGLite persistence, transactional all-or-nothing holds, idempotent confirmation, automatic hold expiry, exact inventory counts, and live seat-map updates via Server-Sent Events.

## Run

```bash
npm install
npm run dev
```

- Backend: http://localhost:3000
- Frontend: http://localhost:5173

For production-style serving:

```bash
npm run build
npm start
```

## API

- `GET /api/seats` — returns all seats after sweeping expired holds.
- `POST /api/holds` with `{ "seatIds": [1,2], "sessionId": "client-a" }` — atomically holds every requested seat or returns `409` and holds none.
- `POST /api/holds/:holdId/confirm` with `{ "sessionId": "client-a" }` — confirms an active hold; repeating the same call is idempotent.
- `DELETE /api/holds/:holdId` with `{ "sessionId": "client-a" }` — releases an active hold early.
- `GET /api/stream` — SSE stream of seat transitions.

Hold TTL defaults to 30 seconds and can be changed with `HOLD_TTL_SECONDS`.
PGLite stores data in `./data/pglite` by default and can be changed with `PGLITE_DATA_DIR`.
