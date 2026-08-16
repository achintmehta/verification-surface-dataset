# Seat Booking

A small client-server seat-booking app for one fixed event. The backend is Express + embedded PGLite, and the frontend is a Vanilla JS/Vite single page app.

## Features

- Fixed persisted seat map: 5 rows × 10 seats.
- Atomic all-or-nothing seat holds with a server-side TTL (`HOLD_TTL_SECONDS`, default 60s).
- Lazy and periodic expiry sweeps that release abandoned holds.
- Transactional confirmation with idempotent retry behavior.
- Early hold release.
- Exact inventory reporting after every read.
- Server-Sent Events at `/api/stream` for live seat status convergence across clients.

## Run

```bash
npm install
npm run dev
```

The API listens on `http://localhost:3001`; Vite serves the frontend on its default port.

For a production-style static frontend build:

```bash
npm run client:build
npm start
```

## API

- `GET /api/seats` — returns all seats and reconciled inventory; expired holds are swept first.
- `POST /api/holds` with `{ "seatIds": ["A-1"], "sessionId": "client-session" }` — atomically holds all requested seats or returns `409` without acquiring any.
- `POST /api/holds/:holdId/confirm` with optional `{ "sessionId": "client-session" }` — books an active hold; repeat calls for an already booked hold return the same booking.
- `DELETE /api/holds/:holdId` — releases an active hold early.
- `GET /api/stream` — SSE stream of snapshots and seat transitions.

Data is persisted under `data/pglite` by default. Override with `PGLITE_DATA_DIR=/path/to/db`.
