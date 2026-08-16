import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { initializeDatabase } from "./db.js";
import { createRouter } from "./routes.js";
import { startPeriodicSweep } from "./expiry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "3001", 10);

async function main() {
  console.log("Initializing database...");
  const db = await initializeDatabase();
  console.log("Database initialized.");

  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // API routes
  const router = createRouter(db);
  app.use(router);

  // Serve static frontend build if present
  const frontendDistPath = path.join(__dirname, "..", "frontend", "dist");
  app.use(express.static(frontendDistPath));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(frontendDistPath, "index.html"));
  });

  // Start periodic sweep of expired holds (every 5 seconds)
  startPeriodicSweep(db, 5000);

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

main().catch(console.error);
