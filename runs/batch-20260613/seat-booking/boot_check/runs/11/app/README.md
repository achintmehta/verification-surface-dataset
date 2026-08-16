# 🎟️ Seat Booking

A single-event seat-booking / ticketing service built for **correctness under concurrency**.
Users place temporary **holds** on seats (with a TTL), then **confirm** those holds to book
the seats permanently. No seat can ever be booked by two different sessions, abandoned holds
expire automatically, and inventory always balances.

- **Backend:** Node.js + Express + embedded [PGLite](https://github.com/electric-sql/pglite)
  (raw SQL + real transactions, persisted to local disk).
- **Real-time:** Server-Sent Events (SSE) push every seat status transition to all clients.
- **Frontend:** Vanilla JS SPA via Vite, rendering a live interactive seat grid.

## Run

```bash
npm install

# Dev: backend (3001) + frontend (5173) together
npm run dev

# Or individually
npm run server   # Express + PGLite on http://localhost:3001
npm run client   # Vite dev server on http://localhost:5173
```

The Vite dev server proxies `/api/*` to the backend, so just open
http://localhost:5173.

## Architecture & guarantees

### Atomic, all-or-nothing holds (`POST /api/holds`)
`createHold` runs in a single transaction. It locks every requested seat row with
`SELECT ... FOR UPDATE`, which serializes concurrent transactions touching the same
seats. It only succeeds if **all** requested seats are available; otherwise it acquires
none and returns `409` with the conflicting seat ids. This makes it impossible for two
concurrent requests to both grab the same seat.

### Time-based expiry (server authoritative)
Each hold stores `expires_at = now + TTL`. Expiry is enforced:
- on every seat read (`GET /api/seats`, SSE snapshot),
- at the start of every hold/confirm operation (inside the same transaction), and
- by a periodic background sweep (`SWEEP_INTERVAL_MS`).

Releases are broadcast over SSE so all clients update. The client-side countdown is only
cosmetic — inventory is never freed by a client timer.

### Idempotent confirmation (`POST /api/holds/:holdId/confirm`)
Confirmation runs in a transaction that re-validates the hold's existence, ownership, and
expiry **before** booking. A hold that is already `confirmed` returns the same booking and
books nothing additional, so retries / double-clicks are safe. Expired or unknown holds
are rejected and book nothing.

### Early release (`DELETE /api/holds/:holdId`)
Returns a hold's still-held seats to `available` and broadcasts the release.

### Inventory invariant
At all times `available + held(active) + booked = total`. Expired holds are reported as
available everywhere, so the counts always reconcile with reality.

## API

| Method & path                      | Purpose                                              |
|------------------------------------|------------------------------------------------------|
| `GET /api/seats`                   | All seats with effective status + inventory + TTL    |
| `GET /api/inventory`               | Available / held / booked / total counts             |
| `POST /api/holds`                  | `{ seatIds, sessionId }` → atomic hold or `409`      |
| `POST /api/holds/:holdId/confirm`  | Book the hold (idempotent)                           |
| `DELETE /api/holds/:holdId`        | Release a hold early                                 |
| `GET /api/stream`                  | SSE stream of seat-status transitions                |

## Configuration

See `server/config.js`:

- `ROWS` × `SEATS_PER_ROW` — the fixed seat map (default 5 × 10 = 50 seats).
- `HOLD_TTL_MS` — hold time-to-live (default 2 minutes).
- `SWEEP_INTERVAL_MS` — background expiry sweep cadence (default 5s).
- `DATA_DIR` — PGLite on-disk data directory (default `./pgdata`).
- `PORT` — backend port (default 3001).
