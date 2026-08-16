# PGLite SSE Message Board

A small traditional client-server web app with:

- Express backend
- Embedded persistent PGLite database
- Server-Sent Events for realtime message fan-out
- Vanilla JavaScript frontend powered by Vite

## Development

```bash
npm install
npm run dev
```

The frontend runs on <http://localhost:5173> and proxies `/api` requests to the backend on <http://localhost:3000>.

## Production

```bash
npm install
npm run build
npm start
```

The Express server serves the built static frontend from `dist/` and stores PGLite data under `data/pglite/`.
