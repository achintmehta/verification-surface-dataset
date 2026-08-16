# Seat Booking

A small traditional client/server web app for a single-event seat map. The backend is Express + embedded PGlite and the frontend is a Vanilla JS Vite SPA.

## Features

- Fixed 5 × 10 persisted seat map.
- Atomic all-or-nothing temporary holds with server-side TTL.
- Transactional, idempotent hold confirmation.
- Early hold release and automatic expiry sweeps.
- Exact inventory endpoint/counts.
- Server-Sent Events for live seat status convergence across clients.

## Run

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:3000

PGlite data is stored under `server/data/pglite` by default. Set `HOLD_TTL_SECONDS` to change the hold TTL.

## API

- `GET /api/seats` — returns all seats after lazily releasing expired holds.
- `POST /api/holds` — `{ "seatIds": [1,2], "sessionId": "client-session" }`; atomically acquires all seats or returns `409` with `conflictingSeatIds`.
- `POST /api/holds/:holdId/confirm` — `{ "sessionId": "client-session" }`; books an active hold, second call returns the same booking.
- `DELETE /api/holds/:holdId` — releases an active hold.
- `GET /api/stream` — SSE stream; `seats` events contain changed seats and the action (`held`, `booked`, `released`).
- `GET /api/inventory` — exact available/held/booked/total counts.
