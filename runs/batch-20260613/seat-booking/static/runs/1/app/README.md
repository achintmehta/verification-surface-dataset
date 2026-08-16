# Seat Booking

A real-time seat-booking / ticketing service for a single event with a fixed seat map.

## Architecture

```
seat-booking/
├── server/          Node.js + Express + PGLite (embedded Postgres)
│   └── src/
│       ├── index.js   Entry point, Express app, periodic sweep
│       ├── db.js      PGLite init, schema, seed (5 rows × 10 seats)
│       ├── seats.js   Business logic: hold, confirm, release, expiry
│       ├── routes.js  REST API route handlers
│       └── sse.js     Server-Sent Events broadcaster
└── client/          Vanilla JS + Vite SPA
    ├── index.html
    └── src/
        ├── main.js    App state machine, seat map rendering, SSE
        ├── api.js     Fetch wrapper for the REST API
        ├── session.js Persistent session id (localStorage)
        └── style.css  Dark-theme seat map UI
```

## Running

```bash
# Install all dependencies (root + workspaces)
npm install

# Start both servers concurrently (dev mode with hot reload)
npm run dev
# → Backend:  http://localhost:3001
# → Frontend: http://localhost:5173
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/seats` | All seats with effective status |
| `POST` | `/api/holds` | Place a hold `{ seatIds, sessionId }` |
| `POST` | `/api/holds/:id/confirm` | Confirm a hold `{ sessionId }` |
| `DELETE` | `/api/holds/:id` | Release a hold early `{ sessionId }` |
| `GET` | `/api/stream` | SSE stream of seat-status events |

## Correctness guarantees

- **Atomic acquisition**: `createHold` runs inside a PGLite transaction; the `WHERE status = 'available'` guard on the UPDATE is the final atomic check. Two concurrent requests for the same seat cannot both succeed.
- **All-or-nothing**: if any requested seat is unavailable the entire transaction is rolled back and a 409 is returned with the conflicting seat ids.
- **Expiry enforcement**: every mutating operation runs `releaseExpiredHoldsInTx` at the start of its transaction, so expired holds are always cleared before new operations proceed.
- **Idempotent confirmation**: a second `POST /api/holds/:id/confirm` for an already-confirmed hold returns the existing booking without any additional writes.
- **Periodic sweep**: a `setInterval` every 10 s releases any holds that slipped through lazy expiry and broadcasts the releases via SSE.
- **Real-time sync**: every seat-status transition (held / booked / released) is broadcast to all connected SSE clients immediately after the transaction commits.
