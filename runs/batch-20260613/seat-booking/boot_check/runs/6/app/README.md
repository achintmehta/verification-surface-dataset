# Seat Booking

A single-event seat booking application with a Node/Express backend, embedded PGLite persistence, atomic hold/confirm logic, automatic hold expiry, and Server-Sent Events updates.

## Run

```bash
npm install
npm start
```

Open `http://localhost:3000` for the app served by Express. For Vite development use:

```bash
npm run dev
```

## API

- `GET /api/seats` returns all seats and exact inventory counts after lazily expiring stale holds.
- `POST /api/holds` with `{ "seatIds": ["A1"], "sessionId": "client-1" }` atomically holds all requested seats or returns `409` with conflicts.
- `POST /api/holds/:holdId/confirm` confirms an active hold idempotently.
- `DELETE /api/holds/:holdId` releases an active hold.
- `GET /api/stream` streams `snapshot` and `seats` SSE events.
