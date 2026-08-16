import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { initDb } from "./db.js";
import { startSweep } from "./expiry.js";
import routes from "./routes.js";

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
app.get("*", (_req, res) => {
  res.sendFile(path.join(frontendDist, "index.html"));
});

// Start
async function start() {
  try {
    await initDb();
    console.log("Database initialized");

    // Start periodic expiry sweep every second
    startSweep(1000);
    console.log("Expiry sweep started");

    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
