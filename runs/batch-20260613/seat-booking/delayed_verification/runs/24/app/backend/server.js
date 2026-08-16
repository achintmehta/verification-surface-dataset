import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { initDb } from "./db.js";
import routes from "./routes.js";
import { startExpirySweep } from "./expiry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend in production
app.use(express.static(path.join(__dirname, "..", "frontend", "dist")));

// API routes
app.use("/api", routes);

// SPA fallback
app.get("*", (req, res) => {
  if (!req.path.startsWith("/api")) {
    res.sendFile(path.join(__dirname, "..", "frontend", "dist", "index.html"));
  }
});

// Start server
async function start() {
  try {
    await initDb();
    console.log("Database initialized");

    // Start periodic expiry sweep (every 1 second)
    startExpirySweep(1000);
    console.log("Expiry sweep started");

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
