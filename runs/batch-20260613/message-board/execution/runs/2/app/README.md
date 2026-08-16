# 📋 Message Board

A real-time message board built with:

- **Backend**: Node.js + Express + [PGLite](https://github.com/electric-sql/pglite) (embedded PostgreSQL)
- **Real-time**: Server-Sent Events (SSE)
- **Frontend**: Vanilla JS + [Vite](https://vitejs.dev/)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser (Vanilla JS / Vite)                            │
│                                                         │
│  ┌──────────────┐   POST /api/messages                  │
│  │ Compose form │──────────────────────────────────┐    │
│  └──────────────┘                                  │    │
│                                                    ▼    │
│  ┌──────────────┐   GET /api/stream (SSE)   ┌──────────┐│
│  │  Message feed│◄──────────────────────────│  Express ││
│  └──────────────┘                           │  Server  ││
│                                             └────┬─────┘│
└─────────────────────────────────────────────────┼───────┘
                                                  │
                                          ┌───────▼──────┐
                                          │   PGLite     │
                                          │  (embedded   │
                                          │  PostgreSQL) │
                                          └──────────────┘
```

## Getting Started

```bash
# Install dependencies
npm install

# Run backend + frontend dev servers concurrently
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

## API

| Method | Path              | Description                          |
|--------|-------------------|--------------------------------------|
| GET    | `/api/messages`   | Fetch all messages (oldest first)    |
| POST   | `/api/messages`   | Post a new message `{ text: string }`|
| GET    | `/api/stream`     | SSE stream – emits `new-message`     |
| GET    | `/health`         | Health check                         |

## Data Persistence

PGLite stores its data in `./data/pglite/` on the local filesystem. This
directory is created automatically on first run and is excluded from version
control via `.gitignore`.

## Project Structure

```
.
├── server/
│   ├── index.js    # Express app entry point
│   ├── db.js       # PGLite initialisation & query helpers
│   ├── routes.js   # API route handlers
│   └── sse.js      # SSE client registry & broadcast helper
├── frontend/
│   ├── index.html  # App shell
│   ├── vite.config.js
│   └── src/
│       ├── main.js   # App bootstrap & event wiring
│       ├── api.js    # Fetch / SSE client helpers
│       ├── ui.js     # DOM manipulation helpers
│       └── style.css # All styles
└── package.json
```
