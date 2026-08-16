# 🎟️ Seat Booking

A concurrency-correct seat-booking service for a single event with a fixed seat
map. Users place temporary **holds** on seats, then **confirm** them to book.
No seat can ever be booked by two sessions; abandoned holds expire
automatically; inventory always balances; and every seat-status change is pushed
live to all viewers via Server-Sent Events.

- **Backend:** Node.js + Express, embedded **PGLite** (raw SQL + transactions),
  persisting to local disk.
- **Frontend:** Vanilla JS Single Page App built with **Vite**.
- **Realtime:** SSE (`EventSource`).

## Getting started

```bash
npm install        # installs backend + frontend deps
npm run dev        # runs API (port 3001) and Vite dev server (port 5173) together
```

Open http://localhost:5173 — the Vite dev server proxies `/api/*` to the backend.

Other scripts:

```bash
npm run dev:server   # backend only (node server/index.js)
npm run dev:client   # frontend only (vite)
npm run build        # production build of the SPA into dist/
npm start            # run the backend server
npm test             # concurrency / correctness test suite
```

### Configuration (env vars)

| Var                 | Default          | Meaning                          |
|---------------------|------------------|----------------------------------|
| `PORT`              | `3001`           | API port                         |
| `HOLD_TTL_MS`       | `60000`          | Hold time-to-live                |
| `SWEEP_INTERVAL_MS` | `5000`           | Background expiry sweep interval |
| `DB_DIR`            | `./server/.pgdata` | PGLite data directory          |

## API

| Method & path                     | Purpose |
|-----------------------------------|---------|
| `GET /api/seats`                  | Full seat map with effective status (expired holds reported available). |
| `POST /api/holds`                 | `{ seatIds, sessionId }` → atomic all-or-nothing hold. `201` with hold, or `409` with `conflicts`. |
| `POST /api/holds/:id/confirm`     | Book held seats; idempotent. `404` unknown, `409` expired/invalid. |
| `DELETE /api/holds/:id`           | Release a hold early. |
| `GET /api/stream`                 | SSE stream of seat-status transitions. |
| `GET /api/inventory`              | `{ available, held, booked, total }` summary. |

## How correctness is guaranteed

- **Atomic acquisition (Decision 1):** every hold runs inside a serialized
  `BEGIN/COMMIT` transaction (an in-process async mutex around PGLite plus a
  conditional `UPDATE … WHERE status='available'`). If even one requested seat
  can't be taken, the whole transaction rolls back — all-or-nothing — and the
  caller gets a `409` listing the conflicting seat ids.
- **Server-side expiry (Decision 2):** each hold stores `expires_at = now + TTL`.
  Expired holds are released *lazily* on every seat read and at the start of every
  hold/confirm/release, **and** by a periodic background sweep. Releases are
  broadcast over SSE. Client timers are never trusted for inventory.
- **Idempotent confirm (Decision 3):** confirm re-validates the hold's existence,
  ownership and expiry inside the transaction. A hold already `confirmed` returns
  the same booking without booking anything additional, so retries/double-clicks
  and concurrent confirms are safe.
- **Exact inventory:** `available + held(active) + booked == total` always holds,
  verified by the test suite under concurrent load.

## Tests

`npm test` spawns the server against a throwaway DB and asserts the acceptance
criteria: 40 concurrent holds on one seat yield exactly one winner; all-or-nothing
multi-seat holds; idempotent + concurrent confirms; auto-expiry releasing seats;
expired/unknown confirms booking nothing; SSE broadcast delivery; and inventory
balance throughout.
