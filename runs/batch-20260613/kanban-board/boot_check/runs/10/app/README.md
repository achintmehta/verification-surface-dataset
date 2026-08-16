# Collaborative Kanban Board

A lightweight multi-user Kanban board backed by an embedded PGLite database and synchronized in real time with Server-Sent Events.

## Scripts

- `npm start` - start the Express API/static server
- `npm run dev` - start the Express API and Vite dev server concurrently
- `npm run build` - build the frontend with Vite

The default API server listens on `PORT` or `3000` and persists PGLite data in `./.pglite-data` unless `PGLITE_DATA_DIR` is set.
