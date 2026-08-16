# Seat Booking

A single-event seat-booking service with atomic hold-with-TTL acquisition,
transactional & idempotent confirmation, automatic hold expiry, exact
inventory accounting, and real-time seat-status broadcasting via SSE.

- **Backend**: Node.js + Express + embedded [PGLite](https://github.com/electric-sql/pglite) (persisted to `data/pgdata`).
- **Frontend**: Vanilla JS SPA built with Vite, live updates via `EventSource`.

## Run

```bash
npm install

# Production-style: build the frontend, serve everything from the API server
npm run build
npm start            # http://localhost:3001

# Or development with hot reload (backend on 3001, Vite on 5173)
npm run dev
```

Config via env: `PORT` (default 3001), `HOLD_TTL_MS` (default 60000),
`PGLITE_DIR` (default `data/pgdata`).

## API

- `GET /api/seats` — all seats with effective status (lazy-expires stale holds).
- `GET /api/inventory` — counts of available/held/booked/total.
- `POST /api/holds` `{ seatIds, sessionId }` — atomic all-or-nothing hold;
  `409 { conflicts }` if any requested seat is unavailable.
- `POST /api/holds/:holdId/confirm` — transactional, idempotent booking.
- `DELETE /api/holds/:holdId` — release a hold early.
- `GET /api/stream` — SSE stream of seat transitions (`event: seats`).

## Correctness model

All mutating operations are serialized through an async lock and run inside
PGLite transactions. Holds acquire seats with a conditional `UPDATE ... WHERE
status = 'available'`; if the affected row count doesn't match the request,
the transaction rolls back and the caller gets the conflicting seat ids.
Expiry is enforced on every read and inside every hold/confirm, plus a 5s
periodic sweep. Confirmation re-validates ownership/expiry and is idempotent.
