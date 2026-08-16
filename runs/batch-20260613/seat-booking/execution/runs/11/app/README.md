# 🎟️ Seat Booking

A concurrency-safe seat-booking / ticketing service for a single event with a
fixed seat map. Users place temporary **holds** on seats, then **confirm** them
to book. The system guarantees that **no seat is ever booked by two users**,
**abandoned holds expire automatically**, and **inventory always balances** —
even under heavy concurrent load. Seat-status changes stream to every connected
client in real time via **Server-Sent Events**.

Built on **Node.js + Express**, an embedded **PGLite** database (raw SQL +
transactions, persisted to local disk), and a lightweight **Vanilla JS / Vite**
single-page frontend.

## Architecture & correctness

- **Atomic seat acquisition** — a hold request acquires *all* requested seats or
  *none*. Acquisition uses a conditional `UPDATE ... WHERE status='available'`
  inside a transaction that is serialized through an in-process mutex
  (`runExclusive` in `server/db.js`), because PGLite runs single-connection
  in-process. Two concurrent requests for the same seat can never both win; the
  loser receives **409** with the conflicting seat ids.
- **Server-side time-based expiry** — every hold stores `expires_at` computed on
  the server. Expiry is enforced on **every seat read** and **before every
  hold/confirm/release**, plus a periodic 5s sweep. Released seats are broadcast.
- **Idempotent confirmation** — confirming the same hold twice books the seats
  exactly once and returns the same booking; confirming an expired/unknown hold
  fails and books nothing.
- **Real-time** — `GET /api/stream` (SSE) broadcasts every `held` / `booked` /
  `released` transition so all seat maps stay live.

## API

| Method & path | Description |
|---|---|
| `GET /api/seats` | All seats with effective status (expired holds reported as available). |
| `POST /api/holds` | Body `{ seatIds, sessionId }`. All-or-nothing hold; 409 + `conflicts` if any seat is taken. |
| `POST /api/holds/:holdId/confirm` | Body `{ sessionId }`. Books the held seats; idempotent. |
| `DELETE /api/holds/:holdId` | Releases a hold early. |
| `GET /api/stream` | SSE stream of seat transitions. |
| `GET /api/inventory` | Diagnostic counts (`available + held + booked == total`). |

## Run

```bash
npm install

# Run backend (PGLite + API + SSE) and Vite dev server together:
npm run dev
# backend: http://localhost:3001   frontend: http://localhost:5173 (proxies /api)

# Or run pieces individually:
npm run server      # backend only on :3001
npm run dev:client  # frontend only on :5173

# Production-style: build the SPA and let the server host it:
npm run build && npm run server   # open http://localhost:3001
```

### Configuration

- `PORT` — server port (default `3001`).
- `HOLD_TTL_MS` — hold time-to-live in ms (default `60000`).
- `PGLITE_DIR` — on-disk data directory (default `./.pgdata`).

## Tests

```bash
npm test
```

The suite (`test/concurrency.test.js`) exercises every acceptance criterion:
exactly-one-winner under 40 concurrent holds for the same seat, all-or-nothing
block contention, holds blocking others, auto-expiry, rejection of
expired/unknown confirms, idempotent and concurrent confirmation, and inventory
balance invariants.
