# Seat Booking

A single-event seat-booking / ticketing service built for **correctness under
concurrency**. Users place temporary holds (with a TTL) on one or more seats,
then confirm those holds to book the seats permanently. No seat can ever be
booked by two different sessions, abandoned holds expire automatically, and the
inventory always reconciles exactly.

- **Backend:** Node.js + Express, embedded **PGLite** (Postgres) for raw SQL and
  transactions, persisted to local disk.
- **Real-time:** Server-Sent Events (SSE) push every seat-status transition to
  all connected clients.
- **Frontend:** Vanilla JS SPA (Vite) rendering an interactive seat map.

## Quick start

```bash
npm install

# Run backend + frontend dev servers together (Vite proxies /api -> :3000)
npm run dev
# frontend: http://localhost:5173   backend: http://localhost:3000

# Or: production-style single server (build + serve static from Express)
npm run build
npm start            # serves UI + API on http://localhost:3000

# Run the correctness / concurrency test suite
npm test
```

## How correctness is guaranteed

- **Atomic, all-or-nothing acquisition.** Each hold runs inside a single SQL
  transaction guarded by an in-process async mutex that serializes all mutating
  operations. A hold succeeds only if *every* requested seat is available; on any
  conflict it acquires nothing and returns `409` with the conflicting seat ids.
  Under many concurrent requests for the same seat, exactly one wins.
- **Server-side TTL expiry.** Every hold stores `hold_expires_at = now + TTL`
  (server time). Expired holds are released lazily on every read and before
  every hold/confirm/release, plus a periodic background sweep. Clients are
  never trusted to free inventory.
- **Idempotent confirmation.** Confirming a hold books its seats inside a
  transaction after re-validating existence and expiry. Confirming the same hold
  again returns the same booking and books nothing additional.
- **Exact inventory.** `available + held(active) + booked == total` at all times.
- **Live convergence.** Every transition (held / booked / released) is broadcast
  over SSE so all seat maps stay in sync.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/seats` | All seats with effective status (expired holds reported available). |
| `GET`  | `/api/inventory` | `{ total, available, held, booked }`. |
| `POST` | `/api/holds` | Body `{ seatIds, sessionId }`. Atomic hold; `409` w/ `conflictSeatIds` on conflict. |
| `POST` | `/api/holds/:holdId/confirm` | Book the hold's seats. Idempotent. `410` if expired/unknown. |
| `DELETE` | `/api/holds/:holdId` | Release a hold early. |
| `GET`  | `/api/stream` | SSE stream of `held` / `booked` / `released` events. |

## Configuration (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `3000` | HTTP port. |
| `DATA_DIR` | `./data/pgdata` | PGLite data directory. |
| `NUM_ROWS` | `5` | Seat-map rows. |
| `SEATS_PER_ROW` | `10` | Seats per row. |
| `HOLD_TTL_MS` | `60000` | Hold lifetime. |
| `SWEEP_INTERVAL_MS` | `5000` | Background expiry sweep interval. |
