# 🎟️ Seat Booking

A small but correctness-focused seat-booking / ticketing service for a single
event with a fixed seat map. Built on an embedded **PGLite** database with raw
SQL transactions, an **Express** HTTP API, **Server-Sent Events** for live seat
updates, and a lightweight **Vanilla JS + Vite** single-page frontend.

The central design goal is **correctness under concurrency**: a seat can never
be booked by two different sessions, abandoned holds always expire, and the
inventory (`available + active-held + booked`) always equals the total seat
count.

## Architecture

```
client/            Vanilla JS SPA (Vite)
  index.html
  main.js          seat map rendering, hold/confirm/release, SSE, countdown
  style.css
server/
  config.js        seat-map size, hold TTL, ports
  db.js            PGLite adapter with a serializing transaction mutex
  booking.js       ALL the booking logic (schema, holds, confirm, expiry)
  sse.js           Server-Sent Events hub
  index.js         Express server wiring booking + SSE + sweep
test/
  booking.test.js  unit tests for the core logic + concurrency
  api.test.js      HTTP integration tests
```

### Data model

A single `seats` table holds the effective state; `holds` and `hold_seats`
track each hold and its seats.

```
seats(id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by)
holds(id, session_id, created_at, expires_at, status)
hold_seats(hold_id, seat_id)
```

`status` is one of `available | held | booked`. A held seat whose
`hold_expires_at` is in the past is treated as **available** on read and is
swept back to available lazily and by a periodic sweep.

## How concurrency correctness is guaranteed

- **Atomic, all-or-nothing holds.** `createHold` runs in a single transaction:
  it `SELECT ... FOR UPDATE`s every requested seat (in sorted id order to avoid
  deadlocks), verifies each is effectively available, then updates them with a
  `WHERE status = 'available'` guard and asserts that *every* requested seat was
  updated. If any seat is unavailable, the transaction aborts and **no** seats
  are acquired; the caller gets a `409` with the conflicting seat ids.
- **Single-writer serialization.** PGLite is a single embedded connection, so
  `db.js` serializes every operation (and every multi-statement transaction)
  through an async mutex. Two concurrent hold requests for the same seat can
  therefore never interleave — exactly one wins.
- **Server-side expiry.** Every read and every hold/confirm operation first
  releases holds whose `expires_at <= now`. A periodic sweep also runs. Clients
  never decide when inventory frees up.
- **Idempotent confirmation.** `confirmHold` is a transaction that re-validates
  the hold's existence, non-expiry and seat ownership before booking. If the
  hold is already `confirmed`, it returns the same booking and books nothing
  additional, so retries and double-clicks are safe.

## API

| Method & path                       | Description                                            |
| ----------------------------------- | ----------------------------------------------------- |
| `GET /api/seats`                    | Full seat map with effective statuses + inventory     |
| `POST /api/holds`                   | `{ seatIds, sessionId }` → 201 `{ hold }` or 409      |
| `POST /api/holds/:holdId/confirm`   | Book the hold's seats (idempotent)                    |
| `DELETE /api/holds/:holdId`         | Release a hold early                                  |
| `GET /api/inventory`                | `{ available, held, booked, total }`                  |
| `GET /api/stream`                   | SSE stream of seat-status transitions                 |

## Running

```bash
npm install

# Backend + frontend dev servers together:
npm run dev

# Or individually:
npm run dev:server   # Express on :3001
npm run dev:client   # Vite on :5173 (proxies /api to :3001)
```

Open http://localhost:5173.

## Tests

```bash
npm test
```

Covers atomic concurrent holds (exactly one of many wins), all-or-nothing
acquisition, active holds blocking others, TTL expiry, idempotent confirmation,
release, and inventory reconciliation — both at the logic and HTTP layers.

## Configuration

Environment variables (all optional):

- `PORT` (default `3001`)
- `HOLD_TTL_MS` (default `120000`)
- `SWEEP_INTERVAL_MS` (default `5000`)
- `DATA_DIR` (default `./pgdata`; persists seat state to disk)
