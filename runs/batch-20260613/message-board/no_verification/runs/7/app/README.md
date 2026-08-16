# PGLite SSE Message Board

A tiny traditional client-server message board that stores messages in embedded PGLite and streams new messages to all connected clients with Server-Sent Events.

## Scripts

- `npm run dev` - run the Express API server and Vite frontend together.
- `npm run dev:server` - run only the backend on `http://localhost:3000`.
- `npm run dev:client` - run only the frontend on `http://localhost:5173`.
- `npm run build` - build the static frontend into `dist/`.
- `npm start` - run the backend server. If `dist/` exists, it will also serve the built frontend.

## API

- `GET /api/messages` - list historical messages.
- `POST /api/messages` - create a message. Body: `{ "text": "Hello" }`.
- `GET /api/stream` - SSE stream that emits newly created messages.
