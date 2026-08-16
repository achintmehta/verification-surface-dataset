# Seat Booking

A greenfield single-event seat-booking application with a Node/Express backend, embedded PGLite persistence, and a Vanilla JS/Vite frontend.

## Features

- Fixed 5 x 10 persisted seat map.
- Atomic all-or-nothing seat holds with a server-side TTL.
- Active holds block all other sessions.
- Expired holds are released lazily on reads/writes and by a periodic sweep.
- Confirming a hold is transactional and idempotent.
- Early hold release endpoint.
- Exact inventory counts from persisted seat state.
- Server-Sent Events broadcast seat status transitions to all connected clients.

## Scripts

```bash
npm run dev        # run backend and Vite frontend together
npm run dev:server # backend only on :3000
npm run dev:client # frontend only on :5173, proxying /api to :3000
npm run build      # build frontend
npm start          # start backend, serving client/dist when present
```

## API

- `GET /api/seats` returns `{ seats, inventory }`, after sweeping expired holds.
- `POST /api/holds` with `{ seatIds, sessionId }` creates an all-or-nothing hold or returns `409 { conflicts }`.
- `POST /api/holds/:holdId/confirm` with `{ sessionId }` confirms an active hold. Repeated confirms return the same booking without changing state again.
- `DELETE /api/holds/:holdId` with `{ sessionId }` releases an active hold.
- `GET /api/stream` opens an SSE stream for `seat-change` events.

The backend stores PGLite data under `./data/pglite` by default. Set `DATABASE_PATH`, `PORT`, or `HOLD_TTL_SECONDS` to override runtime defaults.
