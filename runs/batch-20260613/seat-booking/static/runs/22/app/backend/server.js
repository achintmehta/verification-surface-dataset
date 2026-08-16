import express from "express";
import cors from "cors";
import { getDb, initSchema } from "./db.js";
import { addClient } from "./sse.js";
import { startExpirySweep } from "./expiry.js";
import seatsRouter from "./routes/seats.js";
import holdsRouter from "./routes/holds.js";

const PORT = process.env.PORT || 3000;
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// --- API Routes ---
app.use("/api/seats", seatsRouter);
app.use("/api/holds", holdsRouter);

// SSE endpoint
app.get("/api/stream", (req, res) => {
  addClient(req, res);
});

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// --- Startup ---
async function main() {
  const db = await getDb();
  await initSchema(db);

  // Start periodic expiry sweep (every 2 seconds)
  const sweep = startExpirySweep(db, 2000);

  const server = app.listen(PORT, () => {
    console.log(`Seat booking server running on http://localhost:${PORT}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("Shutting down...");
    sweep.stop();
    server.close(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
