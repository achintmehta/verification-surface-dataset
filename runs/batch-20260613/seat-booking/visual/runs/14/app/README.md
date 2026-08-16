# Live Seat Booking

A single-event seat-booking service built for **correctness under concurrency**.
Users place temporary holds (with a TTL) on seats, then confirm those holds to
book them. No seat can ever be booked by two sessions, abandoned holds expire
automatically, inventory always reconciles, and every status change is pushed
live to all viewers over Server-Sent Events.

## Stack

- **Backend:** Node.js + Express, embedded **PGLite** (PostgreSQL in WASM)
  persisting to `./pgdata` on local disk.
- **Frontend:** Vanilla JS Single Page App built with **Vite**.
- **Realtime:** Server-Sent Events (`/api/stream`).

## Running

```bash
npm install

# Dev: backend (:3001) + Vite dev server (:5173) with /api proxy
npm run dev

# Production: build the SPA, then the Node server serves it on :3001
npm run build
npm start
```

Open http://localhost:5173 (dev) or http://localhost:3001 (built).

## How correctness is guaranteed

- **Atomic acquisition (all-or-nothing).** A hold request locks every requested
  seat (`SELECT ... FOR UPDATE`) inside a transaction, checks that *all* are
  available, and only then marks them held. If any seat is taken, none are
  acquired and the API returns `409` with the conflicting seat ids. All
  write operations are additionally serialized through an in-process FIFO mutex
  because PGLite is a single embedded instance.
- **Server-side TTL expiry.** Each hold stores an `expires_at` computed on the
  server. Expired holds are released lazily on every seat read and before every
  hold/confirm operation, plus a periodic 5s sweep — releases are broadcast.
- **Idempotent confirmation.** Confirming a hold books its seats exactly once;
  a repeated confirm of the same hold returns the same booking and books nothing
  additional. Expired/unknown holds fail and book nothing.
- **Exact inventory.** `available + active-held + booked == total` at all times.

## API

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET`  | `/api/seats` | All seats with effective status + hold TTL |
| `GET`  | `/api/inventory` | Counts: available / held / booked / total |
| `POST` | `/api/holds` | `{ seatIds, sessionId }` → 201 hold, or 409 `{ conflicts }` |
| `POST` | `/api/holds/:id/confirm` | Book held seats (idempotent) |
| `DELETE` | `/api/holds/:id` | Release a hold early |
| `GET`  | `/api/stream` | SSE: `held` / `booked` / `released` events |

## Tests

With the server running on :3001:

```bash
node test-concurrency.mjs   # races, idempotency, release, inventory
node test-sse.mjs           # broadcast delivery

# Expiry (run a short-TTL server first):
HOLD_TTL_MS=2000 PORT=3002 node server/index.js &
node test-expiry.mjs
```
