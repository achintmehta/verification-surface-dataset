# Collaborative Kanban Board

A small client-server Kanban board using Express, embedded PGLite, Server-Sent Events, and a Vite/Vanilla JS frontend.

## Development

```bash
npm install
npm run dev
```

The API server listens on `http://localhost:3001` by default and Vite serves the client on `http://localhost:5173`.

Set `PORT` for the server port, `DATABASE_DIR` for the PGLite data directory, and `VITE_API_URL` for the frontend API base URL if needed.
