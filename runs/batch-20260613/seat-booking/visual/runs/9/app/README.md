# Seat Booking

A small client-server seat-booking application using Express, embedded PGLite, and Server-Sent Events.

## Run

```bash
npm install
npm run dev
```

Backend: `http://localhost:3001`  
Frontend: `http://localhost:5173`

## API

- `GET /api/seats` - current seat map and inventory; expired holds are swept first.
- `POST /api/holds` - `{ "seatIds": ["A1"], "sessionId": "client-id" }`; all-or-nothing hold.
- `POST /api/holds/:holdId/confirm` - `{ "sessionId": "client-id" }`; idempotent booking confirmation.
- `DELETE /api/holds/:holdId?sessionId=client-id` - early hold release.
- `GET /api/stream` - SSE status transitions.

PGLite persists under `data/pglite` by default.
