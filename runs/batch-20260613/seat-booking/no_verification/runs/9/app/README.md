# Seat Booking

A single-event seat-booking application with a Node/Express backend, embedded PGLite persistence, transactional hold/confirm/release logic, automatic hold expiry, and Server-Sent Events for live seat-map updates.

## Run

```bash
npm install
npm run dev
```

- Backend: http://localhost:3000
- Frontend (Vite): http://localhost:5173

For a production-style run:

```bash
npm run build
npm start
```

The embedded database is persisted under `pglite-data/`.

## API

- `GET /api/seats` — returns all seats and exact inventory after lazily expiring stale holds.
- `POST /api/holds` with `{ "seatIds": ["A-1"], "sessionId": "..." }` — atomically holds all seats or returns `409` and holds none.
- `POST /api/holds/:holdId/confirm` with `{ "sessionId": "..." }` — confirms an active hold; repeated confirmation is idempotent.
- `DELETE /api/holds/:holdId` with `{ "sessionId": "..." }` — releases an active hold early.
- `GET /api/stream` — SSE stream broadcasting seat status transitions.

## Notes

The backend serializes database mutations through a process-local queue and still performs all state changes inside SQL transactions with conditional updates. Expired holds are released before reads and before hold/confirm/release operations, plus a periodic sweep broadcasts automatic releases.
