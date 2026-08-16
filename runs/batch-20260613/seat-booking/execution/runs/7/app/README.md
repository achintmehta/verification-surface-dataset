# Seat Booking

A greenfield single-event seat booking application with:

- Node/Express backend
- Embedded PGLite persistence
- Atomic all-or-nothing temporary holds with server-side TTL
- Transactional/idempotent confirmation
- Lazy and periodic hold expiry
- Server-Sent Events for live seat-state updates
- Vanilla JS/Vite frontend

## Run

```bash
npm install
npm run dev
```

Backend: `http://localhost:3000`  
Frontend: `http://localhost:5173`

Set `VITE_API_BASE` if the frontend should call a different API origin.

## API

- `GET /api/seats` returns all seats and inventory after sweeping expired holds.
- `POST /api/holds` with `{ "seatIds": ["A1"], "sessionId": "client-session" }` atomically holds every requested available seat or returns `409` with `conflictingSeatIds`.
- `POST /api/holds/:holdId/confirm` with `{ "sessionId": "client-session" }` confirms an active hold and is idempotent for already-confirmed holds.
- `DELETE /api/holds/:holdId` releases an active hold early.
- `GET /api/stream` streams seat transitions with SSE.

The fixed seed map is 5 rows (A-E) by 10 seats.
