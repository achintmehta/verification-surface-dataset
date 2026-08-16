import express from "express";
import cors from "cors";
import { getDb } from "./db.js";
import routes from "./routes.js";
import { startPeriodicSweep } from "./expiry.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use("/api", routes);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

async function start() {
  // Initialize the database
  await getDb();
  console.log("Database initialized.");

  // Start periodic sweep for expired holds (every 1 second)
  startPeriodicSweep(1000);
  console.log("Periodic hold sweep started.");

  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
