import express from "express";
import cors from "cors";
import { initDb } from "./db.js";
import routes from "./routes.js";
import { startExpirySweep } from "./expiry.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API routes
app.use("/api", routes);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

async function start() {
  try {
    await initDb();
    console.log("Database initialized");

    // Start periodic expiry sweep every second
    startExpirySweep(1000);

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (e) {
    console.error("Failed to start server:", e);
    process.exit(1);
  }
}

start();
