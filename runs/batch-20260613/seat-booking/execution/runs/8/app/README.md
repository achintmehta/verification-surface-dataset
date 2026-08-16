# Seat Booking

Concurrent-safe single-event seat booking using Express, embedded PGLite, Server-Sent Events, and a vanilla Vite frontend.

## Run

```bash
npm install
npm run dev
```

- Backend: `http://localhost:3000`
- Frontend: Vite dev server (usually `http://localhost:5173`)

You can also run only the backend with `npm start`.

## API

- `GET /api/seats` returns the full seat map plus exact inventory. Expired holds are released before returning data.
- `POST /api/holds` with `{ "seatIds": ["A1", "A2"], "sessionId": "client-1" }` atomically holds all requested seats or returns `409` with conflicts.
- `POST /api/holds/:holdId/confirm` with `{ "sessionId": "client-1" }` confirms an active hold idempotently.
- `DELETE /api/holds/:holdId` with `{ "sessionId": "client-1" }` releases an active hold early.
- `GET /api/stream` is an SSE stream broadcasting seat transitions.

## Correctness notes

The server serializes mutating database work through a write queue and performs hold, confirm, release, and expiry in SQL transactions. Hold acquisition is all-or-nothing and uses conditional `UPDATE ... WHERE status = 'available'`. Expiry is enforced before reads and before every hold/confirm/release operation, plus by a periodic sweep. Confirmations write a ledger row inside the booking transaction so retrying the same confirm returns the original booking without changing seats again.

PGLite data is persisted in `./.pglite-data` by default. Set `PGLITE_DATA_DIR` to change the location or delete that directory to reset the seeded seat map.
