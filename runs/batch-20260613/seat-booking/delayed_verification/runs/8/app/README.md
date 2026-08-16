# Seat Booking

A small client-server seat booking application using Express, PGLite, and Server-Sent Events.

## Development

```bash
npm install
npm run dev
```

Backend defaults to `http://localhost:3000`; Vite frontend defaults to `http://localhost:5173`.

## API

- `GET /api/seats`
- `GET /api/inventory`
- `POST /api/holds` with `{ "seatIds": ["A-1"], "sessionId": "client-1" }`
- `POST /api/holds/:holdId/confirm` with `{ "sessionId": "client-1" }`
- `DELETE /api/holds/:holdId` with optional `{ "sessionId": "client-1" }`
- `GET /api/stream`
