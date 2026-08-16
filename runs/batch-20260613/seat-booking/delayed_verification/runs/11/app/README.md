# 🎫 Seat Booking

A concurrency-correct seat-booking / ticketing service for a single event,
built on **Node.js + Express**, **embedded PGLite** for transactional SQL, and
**Server-Sent Events (SSE)** to keep every connected seat map live. The frontend
is a lightweight Vanilla JS SPA served by **Vite**.

## Features

- Fixed seat map (default **5 rows × 10 seats**) persisted to local disk via PGLite.
- **Atomic, all-or-nothing holds** with a TTL: a hold request acquires *every*
  requested seat or none of them.
- **Idempotent confirmation**: confirming the same hold repeatedly books the
  seats exactly once.
- **Automatic expiry**: holds past their TTL are released lazily (on every read
  and mutation) and by a periodic background sweep.
- **Exact inventory**: `available + held(active) + booked == total` at all times.
- **Real-time updates**: every seat transition (held / booked / released) is
  broadcast over SSE.

## Project layout

```
.
├── package.json          # scripts + deps for both server and client
├── vite.config.js        # Vite dev server + /api proxy to the Node server
├── server/
│   ├── index.js          # Express app, routes, SSE endpoint, sweep timer
│   ├── config.js         # tunables (seat map size, TTL, sweep interval)
│   ├── db.js             # PGLite init + schema + seat seeding
│   ├── seatService.js    # atomic hold / confirm / release / expiry logic
│   └── sse.js            # SSE connection registry + broadcast
└── public/
    ├── index.html
    ├── style.css
    └── main.js           # SPA: seat map, selection, hold, confirm, SSE
```

## Getting started

```bash
npm install
npm run dev      # runs the API server (:3000) and Vite dev server (:5173)
```

Open http://localhost:5173. Vite proxies `/api/*` (including the SSE stream) to
the Node server on port 3000.

To run only the backend (it also serves nothing static; use Vite or `npm run build`
+ `npm run preview` for the UI):

```bash
npm run dev:server
```

### Environment variables

| Variable            | Default          | Description                       |
| ------------------- | ---------------- | --------------------------------- |
| `PORT`              | `3000`           | API server port                   |
| `PGLITE_DIR`        | `./server/.pgdata` | PGLite data directory           |
| `SEAT_ROWS`         | `5`              | Number of rows                    |
| `SEATS_PER_ROW`     | `10`             | Seats per row                     |
| `HOLD_TTL_MS`       | `120000`         | Hold time-to-live (ms)            |
| `SWEEP_INTERVAL_MS` | `5000`           | Background expiry sweep interval  |

## API

### `GET /api/seats`
Returns every seat with its effective status (expired holds reported as
`available`), plus `holdTtlMs`.

### `POST /api/holds`
Body: `{ "seatIds": ["A1","A2"], "sessionId": "..." }`

- `201` → `{ hold: { id, sessionId, expiresAt, seatIds } }`
- `409` → `{ error: "seats_unavailable", conflicts: ["A2"] }` (acquired nothing)

### `POST /api/holds/:holdId/confirm`
Body: `{ "sessionId": "..." }` (optional ownership check)

- `200` → `{ booking: { holdId, sessionId, seatIds }, idempotent }`
- `404`/`409` → `{ error: "unknown_hold" | "expired" | ... }` (books nothing)

Idempotent: a second confirm returns the same booking and books nothing extra.

### `DELETE /api/holds/:holdId`
Body or query: `sessionId`. Releases an active hold early; its seats return to
`available`.

### `GET /api/inventory`
Diagnostics: `{ available, held, booked, total }` (forces an expiry sweep first).

### `GET /api/stream`
SSE stream. Emits `event: seats` with
`data: { type: "held"|"booked"|"released", seats: [...] }` on every transition.

## How correctness is guaranteed

- **No double-booking under concurrency.** All mutating operations are serialized
  through an in-process async mutex *and* executed inside a single PGLite
  transaction. The hold acquisition uses a conditional
  `UPDATE ... WHERE status = 'available'` and verifies it acquired every
  requested seat; otherwise the transaction rolls back (all-or-nothing).
- **Holds block others.** Held seats have `status = 'held'`; the hold's
  conditional update and the availability check both exclude them.
- **Expiry without manual action.** `expires_at` is computed server-side. Before
  every read and every mutation we run an expiry sweep that releases stale holds;
  a periodic timer also sweeps even when there is no traffic.
- **Idempotent confirm.** Confirm re-validates the hold inside the transaction.
  If the hold is already `confirmed`, it returns the existing booking and books
  nothing more.
- **Exact inventory.** Because expiry is enforced on read, the reported
  available/held/booked counts always reconcile to the total seat count.
- **Convergence.** Every transition is broadcast over SSE, so all clients
  re-render to the same state.
