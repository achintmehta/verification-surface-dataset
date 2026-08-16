# Seat Booking

A small client-server seat-booking application with an Express backend, embedded PGLite persistence, atomic hold/confirm logic, automatic hold expiry, and Server-Sent Events updates.

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

## API

- `GET /api/seats` - returns the effective seat map after lazily expiring stale holds.
- `GET /api/inventory` - exact total/available/held/booked counts.
- `POST /api/holds` with `{ "seatIds": ["A1"], "sessionId": "session-a" }` - all-or-nothing temporary hold.
- `POST /api/holds/:holdId/confirm` with `{ "sessionId": "session-a" }` - idempotent confirmation.
- `DELETE /api/holds/:holdId` with `{ "sessionId": "session-a" }` - early release.
- `GET /api/stream` - SSE stream broadcasting `seat-change` events.

## Correctness notes

The backend serializes write operations and executes hold, confirm, release, and expiry mutations inside PGLite transactions. Each hold request first expires stale holds, then validates that every requested seat exists and is currently available before marking any of them held. Confirmation revalidates hold ownership, active status, and expiry inside the transaction, and confirmed holds remain idempotently confirmable.
