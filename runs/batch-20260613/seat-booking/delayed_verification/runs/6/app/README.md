# Seat Booking

A greenfield single-event seat-booking app with a Node/Express API, embedded PGLite persistence, atomic all-or-nothing seat holds, idempotent confirmation, automatic TTL expiry, exact inventory counts, and live Server-Sent Events updates.

## Run

```bash
npm install
npm run dev
```

- API: `http://localhost:3001`
- Frontend: `http://localhost:5173`

Set `HOLD_TTL_MS` to change the default 30 second hold duration. PGLite data is persisted under `./data/pglite` by default; override with `PGLITE_DATA_DIR`.

## API

- `GET /api/seats` returns all seats plus inventory. Expired holds are lazily released before the response.
- `POST /api/holds` with `{ "seatIds": ["A1"], "sessionId": "client-session" }` atomically holds all requested available seats or returns `409` with conflicts.
- `POST /api/holds/:holdId/confirm` with `{ "sessionId": "client-session" }` books an active hold. Repeating the request is idempotent.
- `DELETE /api/holds/:holdId` with `{ "sessionId": "client-session" }` releases an active hold early.
- `GET /api/stream` emits `snapshot` and `seats` SSE events for live seat-map convergence.
