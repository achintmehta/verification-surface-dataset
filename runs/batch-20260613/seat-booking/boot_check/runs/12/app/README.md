# Seat Booking

A concurrency-safe seat-booking service for a single event. Embedded PGLite for
transactional storage, Express for the API, SSE for live updates, and a Vanilla
JS (Vite) SPA for the seat map.

## Run

```bash
npm install

# dev: backend (3001) + Vite frontend (5173) with /api proxy
npm run dev

# or run pieces separately
npm run server   # Express + PGLite on :3001
npm run client   # Vite dev server on :5173

# production-ish: build SPA then serve everything from the Express server
npm run build && npm start   # http://localhost:3001
```

## Design highlights

- **Atomic holds (all-or-nothing):** `POST /api/holds` locks the requested
  seats `FOR UPDATE` inside a transaction, verifies every seat is effectively
  available, then conditionally updates them to `held`. If even one seat is
  taken, it acquires none and returns `409` with the conflicting seat ids.
- **Server-side TTL expiry:** every hold stores `expires_at = now + TTL`.
  Expiry is enforced lazily on every seat read and before every hold/confirm,
  plus a periodic sweep. Released seats are broadcast.
- **Idempotent confirm:** `POST /api/holds/:id/confirm` re-validates existence,
  ownership, and expiry inside a transaction. A second confirm of an already
  confirmed hold returns the same booking and books nothing more.
- **Exact inventory:** available + active-held + booked always equals the total
  seat count.
- **Live updates:** `GET /api/stream` is an SSE endpoint; every seat transition
  (held / booked / released) is pushed to all clients.

## API

| Method | Path                          | Body                          |
|--------|-------------------------------|-------------------------------|
| GET    | `/api/seats`                  | —                             |
| GET    | `/api/inventory`              | —                             |
| POST   | `/api/holds`                  | `{ seatIds: [], sessionId }`  |
| POST   | `/api/holds/:holdId/confirm`  | —                             |
| DELETE | `/api/holds/:holdId`          | —                             |
| GET    | `/api/stream`                 | SSE                           |

Configure `HOLD_TTL_MS` (default 60000) and `PORT` (default 3001) via env vars.
