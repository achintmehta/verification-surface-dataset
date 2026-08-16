import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { getDb, initDb } from "./db.js";
import { startExpiryLoop } from "./expiry.js";
import { broadcast } from "./sse.js";
import seatsRouter from "./routes/seats.js";
import holdsRouter from "./routes/holds.js";
import streamRouter from "./routes/stream.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;

const app = express();

app.use(cors());
app.use(express.json());

// API routes
app.use("/api/seats", seatsRouter);
app.use("/api/holds", holdsRouter);
app.use("/api/stream", streamRouter);

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Serve frontend static files in production
const frontendDist = path.join(__dirname, "..", "frontend", "dist");
app.use(express.static(frontendDist));
app.get("*", (_req, res) => {
  res.sendFile(path.join(frontendDist, "index.html"), (err) => {
    if (err) res.status(404).send("Not found");
  });
});

async function start() {
  const db = await getDb();
  await initDb(db);
  console.log("[db] PGLite ready");

  // Start the periodic expiry sweep (every 5 s)
  startExpiryLoop(getDb, broadcast, 5000);

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("[startup] fatal:", err);
  process.exit(1);
});

export { app };
