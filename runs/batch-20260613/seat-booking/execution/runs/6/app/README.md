# Seat Booking

A traditional client-server seat booking demo for a single fixed event. The backend uses Express and embedded PGLite with raw SQL transactions; the frontend is a lightweight Vite / Vanilla JS SPA. Server-Sent Events keep all connected seat maps synchronized.

## Features

- Fixed 5 × 10 persisted seat map.
- Atomic all-or-nothing seat holds with server-side TTL.
- Lazy and periodic expiry of abandoned holds.
- Idempotent hold confirmation.
- Early hold release.
- Exact inventory endpoint/counts.
- SSE broadcasts for held, booked, and released transitions.

## Run

```bash
npm install
npm run dev
```

- Backend: `http://localhost:3000`
- Vite frontend: `http://localhost:5173`

For production-style serving:

```bash
npm run build
npm start
```

## API

- `GET /api/seats` — returns all seats and inventory; first releases expired holds.
- `POST /api/holds` with `{ "seatIds": ["A1"], "sessionId": "client-id" }` — atomically holds all requested seats or returns `409` with `conflictingSeatIds`.
- `POST /api/holds/:holdId/confirm` with `{ "sessionId": "client-id" }` — confirms a live hold; safe to retry.
- `DELETE /api/holds/:holdId` with `{ "sessionId": "client-id" }` — releases a live hold.
- `GET /api/stream` — SSE stream emitting `snapshot` and `seats` events.

Data is stored under `data/pglite`.
