import express from "express";
import cors from "cors";
import router from "./routes.js";
import { getDb } from "./db.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use("/api", router);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

async function start() {
  // Initialize DB first
  await getDb();
  console.log("PGLite database initialized");

  app.listen(PORT, () => {
    console.log(`Kanban server listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
