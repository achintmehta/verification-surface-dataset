import express from "express";
import cors from "cors";
import { initDb } from "./db.js";
import { startSweep } from "./expiry.js";
import routes from "./routes.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;

async function main() {
  // Initialize the database (creates tables, seeds data)
  await initDb();
  console.log("Database initialized");

  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // API routes
  app.use("/api", routes);

  // Serve frontend static files in production
  const frontendDist = path.join(__dirname, "..", "frontend", "dist");
  app.use(express.static(frontendDist));
  app.get("*", (req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });

  // Start the periodic sweep for expired holds (every 1 second)
  startSweep(1000);

  app.listen(PORT, () => {
    console.log(`Seat booking server running on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
