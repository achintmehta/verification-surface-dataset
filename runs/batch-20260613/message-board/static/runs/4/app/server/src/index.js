/**
 * index.js – Entry point for the message-board Express server.
 *
 * Responsibilities:
 *  1. Create and configure the Express application (CORS, JSON body parsing).
 *  2. Mount the /api/messages router.
 *  3. Mount the /api/stream SSE handler.
 *  4. Initialise PGLite (eagerly, so the first request isn't slow).
 *  5. Start listening on PORT (default 3001).
 */

import express from "express";
import cors from "cors";
import { getDb } from "./db.js";
import { sseHandler } from "./sse.js";
import messagesRouter from "./routes/messages.js";

const PORT = process.env.PORT ?? 3001;

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Allow the Vite dev server (port 5173) and any other origin to reach the API.
// In production you would tighten this to your actual frontend origin.
app.use(
  cors({
    origin: true,          // reflect the request origin
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Real-time SSE stream.
app.get("/api/stream", sseHandler);

// REST endpoints for messages.
app.use("/api/messages", messagesRouter);

// Simple health-check so you can verify the server is up.
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Eagerly initialise the database so the first HTTP request doesn't pay the
// PGLite startup cost.
getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("[server] Failed to initialise database:", err);
    process.exit(1);
  });
