# Seat Booking

A traditional client-server seat booking application for a single fixed event. The backend uses Express and embedded PGLite with raw SQL transactions; the frontend is a Vanilla JS/Vite single page app with Server-Sent Events for live seat-state updates.

## Features

- Fixed 5 × 10 persisted seat map.
- Atomic all-or-nothing seat holds with server-side TTL.
- Confirmation flow that is transactional and idempotent.
- Early hold release endpoint.
- Lazy and periodic server-side hold expiry.
- Exact inventory counts for available, held, and booked seats.
- SSE broadcasts for held, booked, and released seat transitions.

## Run

```bash
npm install
npm run dev
```

- API: `http://localhost:3000`
- Vite frontend: `http://localhost:5173`

For production-style serving:

```bash
npm run build
npm start
```

Then open `http://localhost:3000`.

## API

### `GET /api/seats`

Returns all seats and inventory. Expired holds are swept before the response.

### `POST /api/holds`

Body:

```json
{ "seatIds": [1, 2], "sessionId": "client-session" }
```

Atomically holds all requested seats if every requested seat is available. Returns `409` with conflicts if any seat is missing, held, or booked.

### `POST /api/holds/:holdId/confirm`

Body:

```json
{ "sessionId": "client-session" }
```

Confirms an active hold. Repeating the same confirm returns the original booking id and does not book anything additional.

### `DELETE /api/holds/:holdId`

Body:

```json
{ "sessionId": "client-session" }
```

Releases an active hold early.

### `GET /api/stream`

SSE endpoint emitting `seat-update`, `connected`, and `heartbeat` events.

## Correctness notes

PGLite runs embedded in this Node process. The server serializes critical transactions through an in-process mutex and performs every hold/confirm/release as a SQL transaction. Hold acquisition first sweeps expired holds, checks every requested seat, and only then updates all seats. On any conflict it updates none. Confirmation revalidates the hold owner, status, expiry, and owned seats in the transaction before booking.
