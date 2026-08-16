# 📋 Message Board

A real-time message board built with **Node.js / Express**, **PGLite** (embedded PostgreSQL), and **Server-Sent Events (SSE)**. The frontend is plain **Vanilla JS** served by **Vite**.

## Quick Start

```bash
npm install
npm run dev
```

This starts both the backend (port 3000) and the Vite dev server (port 5173) concurrently. Open **http://localhost:5173** in your browser.

## Production

```bash
npm run build
npm start
```

The built client assets are served by Express on **http://localhost:3000**.

## Testing

```bash
npm test
```

## Architecture

```
┌──────────────┐   SSE (GET /api/stream)   ┌────────────────────┐
│   Browser    │ ◄──────────────────────────│   Express Server   │
│  (Vanilla JS)│ ──── POST /api/messages ──►│   + PGLite (WASM)  │
└──────────────┘   GET /api/messages        └────────────────────┘
```

- **PGLite** runs PostgreSQL directly inside the Node.js process – no external database needed.
- **SSE** pushes new messages to all connected clients in real time.
- Messages are persisted to disk in the `data/pglite/` directory.
