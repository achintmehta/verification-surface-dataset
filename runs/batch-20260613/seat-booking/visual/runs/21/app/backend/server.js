import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { getDb } from "./db.js";
import routes from "./routes.js";
import { startPeriodicSweep } from "./expiry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files in production
app.use(express.static(path.join(__dirname, "..", "frontend", "dist")));

// API routes
app.use("/api", routes);

// Catch-all for SPA
app.get("*", (req, res) => {
  if (!req.path.startsWith("/api")) {
    res.sendFile(path.join(__dirname, "..", "frontend", "dist", "index.html"));
  }
});

async function start() {
  try {
    // Initialize database
    await getDb();
    console.log("Database initialized.");

    // Start periodic hold expiry sweep (every 1 second)
    startPeriodicSweep(1000);
    console.log("Periodic sweep started.");

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
