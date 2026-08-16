# Seat Booking

A single-event seat-booking service with strict correctness under concurrency,
built on an embedded PGLite database and real-time Server-Sent Events.

## Architecture

- **Backend** (`server/`): Node.js + Express + embedded
  [PGLite](https://github.com/electric-sql/pglite) persisting to local disk.
- **Frontend** (`client/`): Vanilla JS SPA served by Vite, rendering an
  interactive seat grid that stays live via `EventSource`.

### Correctness model

- **Atomic acquisition** — a hold for N seats succeeds only if *every*
  requested seat is currently available. Acquisition is a single conditional
  `UPDATE ... WHERE status = 'available'` inside a transaction; if fewer rows
  than requested are flipped, the transaction is rolled back (all-or-nothing)
  and the caller receives `409` with the conflicting seat ids.
- **App-level serialization** — all mutating operations run behind an in-process
  promise mutex (`withLock`) so PGLite's single engine never interleaves the
  statements of two transactions, eliminating check-then-act races.
- **Time-based expiry** — each hold stores `expires_at = now + TTL`. Expiry is
  enforced lazily on every read and before every hold/confirm/release, plus a
  periodic background sweep. Clients never free inventory via their own timers.
- **Idempotent confirmation** — confirming an already-confirmed hold returns the
  same booking and books nothing additional. Confirming an expired/unknown hold
  fails (`410`/`404`) and books nothing.
- **Exact inventory** — `available + held(active) + booked == total` at all times
  (`GET /api/inventory`).
- **Live updates** — every transition (held / booked / released) is broadcast
  over SSE so all connected seat maps converge.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/seats` | Seat map with effective status (expired holds reported available). |
| `GET` | `/api/inventory` | Counts of available/held/booked/total. |
| `POST` | `/api/holds` | Body `{ seatIds, sessionId }`. Atomic hold; `409` w/ conflicts if any seat taken. |
| `POST` | `/api/holds/:holdId/confirm` | Book the hold's seats. Idempotent. |
| `DELETE` | `/api/holds/:holdId` | Release a hold early. |
| `GET` | `/api/stream` | SSE stream (`snapshot`, `seats` events). |

## Running

```bash
npm install
npm run dev      # backend (3001) + Vite frontend (5173) concurrently
```

Then open http://localhost:5173. The Vite dev server proxies `/api/*` to the
backend.

To run the backend alone: `npm run server`. To build the frontend:
`npm run build`.

## Configuration (env vars)

- `PORT` (default `3001`)
- `DB_DIR` (default `./data/pgdata`)
- `ROWS` / `SEATS_PER_ROW` (default `5` × `10`)
- `HOLD_TTL_MS` (default `60000`)
- `SWEEP_INTERVAL_MS` (default `5000`)
