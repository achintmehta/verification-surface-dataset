# Seat Booking

A small client-server ticketing app for one fixed seat map. The backend is Express + embedded PGLite and enforces all-or-nothing seat holds, TTL expiry, idempotent confirmation, exact inventory, and SSE updates. The frontend is a Vanilla JS/Vite SPA.

## Run

```bash
npm install
npm run dev
```

- API: http://localhost:3000
- Frontend: http://localhost:5173

## API

- `GET /api/seats` — current effective seat map and inventory. Expired holds are swept before the response.
- `POST /api/holds` — body `{ "seatIds": ["A1"], "sessionId": "client-id" }`; atomically holds all seats or returns `409` with `conflictingSeatIds`.
- `POST /api/holds/:holdId/confirm` — body `{ "sessionId": "client-id" }`; confirms once and returns the same booking on retries.
- `DELETE /api/holds/:holdId` — releases an active hold early.
- `GET /api/stream` — Server-Sent Events for `seats-changed` transitions.

PGLite data is persisted in `.pglite/` by default. Set `PGLITE_DATA_DIR` to override. Set `HOLD_TTL_MS` to override the default 30 second hold TTL.
