# Seat Booking

A concurrency-safe seat booking / ticketing service for a single event with a
fixed seat map (5 rows × 10 seats). Built on an embedded PostgreSQL (PGLite)
inside a Node.js / Express backend, with a Vanilla JS + Vite frontend and
Server-Sent Events keeping every seat map live.

## Run

```bash
npm install
npm run dev      # backend (3001) + Vite dev server (5173)
```

Open http://localhost:5173 in two browser windows to see live updates.

For a production-style single-process run:

```bash
npm run build    # builds the SPA into dist/
npm start        # serves API + static SPA on :3001
```

## Architecture

- **Backend** (`server/`): Express + `@electric-sql/pglite`.
  - `db.js` — PGLite init (persists to `./pgdata`), schema, and seat seeding.
  - `booking.js` — all transactional logic: atomic holds, idempotent confirm,
    early release, lazy + periodic expiry, inventory.
  - `sse.js` — SSE client registry and broadcast helper.
  - `index.js` — HTTP routes and the `/api/stream` SSE endpoint.
- **Frontend** (`src/`): renders the seat grid, selection + hold + confirm flow
  with a TTL countdown, and an `EventSource` subscription for live updates.

## Correctness guarantees

- **Atomic acquisition**: a hold locks all requested seat rows with
  `SELECT ... FOR UPDATE` inside a transaction and only succeeds if *every*
  requested seat is available — otherwise it acquires none and returns `409`
  with the conflicting seat ids. Two concurrent requests for the same seat
  serialize on the row lock so exactly one wins.
- **Server-side expiry**: each hold stores `expires_at = now() + TTL`. Expiry is
  enforced lazily on every seat read and at the start of every hold/confirm
  operation, plus a 5s periodic sweep. Released seats are broadcast.
- **Idempotent confirm**: confirming re-validates existence, status, expiry and
  seat ownership inside one transaction before booking. A second confirm of an
  already-confirmed hold returns the same booking and books nothing more.
- **Exact inventory**: `available + held(active) + booked == total` always,
  because expired holds are reconciled before any count is read.

## API

- `GET  /api/seats` — all seats with effective status + inventory + ttl.
- `POST /api/holds` — `{ seatIds, sessionId }` → `201 { hold }` or `409 { conflicts }`.
- `POST /api/holds/:holdId/confirm` — `{ booking, idempotent }`.
- `DELETE /api/holds/:holdId` — release a hold early.
- `GET  /api/stream` — SSE stream of `seats` events (`held` / `booked` / `released`).
