# Seat Booking

A single-event seat booking demo with an Express backend, embedded PGLite persistence, atomic holds, idempotent confirmation, automatic hold expiry, and live Server-Sent Events updates.

## Run

```bash
npm install
npm run dev
```

Frontend: http://localhost:5173
Backend: http://localhost:3000

## API

- `GET /api/seats` — full seat map and inventory counts.
- `POST /api/holds` — `{ "seatIds": ["A-1"], "sessionId": "client-id" }`.
- `POST /api/holds/:holdId/confirm` — confirm an active hold idempotently.
- `DELETE /api/holds/:holdId` — release an active hold early.
- `GET /api/stream` — SSE seat updates.
