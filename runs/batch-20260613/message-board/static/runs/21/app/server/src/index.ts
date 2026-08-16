import express from "express";
import cors from "cors";
import { getDb } from "./db.js";
import messagesRouter from "./routes/messages.js";
import streamRouter from "./routes/stream.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/messages", messagesRouter);
app.use("/api/stream", streamRouter);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function start(): Promise<void> {
  // Ensure the database is initialised before accepting requests
  await getDb();
  console.log("Database initialised");

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
