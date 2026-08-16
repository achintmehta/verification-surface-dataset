import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { initDb } from "./db.js";
import routes from "./routes.js";
import { startPeriodicSweep } from "./expiry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// API routes
app.use("/api", routes);

// Serve frontend static files in production
const frontendDist = path.join(__dirname, "..", "frontend");
app.use(express.static(frontendDist));

// SPA fallback
app.get("*", (req, res) => {
  if (!req.path.startsWith("/api")) {
    res.sendFile(path.join(frontendDist, "index.html"));
  }
});

async function start() {
  try {
    await initDb();
    console.log("Database initialized.");

    // Start periodic hold expiry sweep (every 1 second)
    startPeriodicSweep(1000);

    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
