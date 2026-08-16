import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { initializeDatabase } from "./db.ts";
import { createRouter } from "./routes.ts";
import { startExpirySweep } from "./expiry.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);

async function main(): Promise<void> {
  console.log("Initializing database...");
  const db = await initializeDatabase();
  console.log("Database initialized.");

  const app = express();

  app.use(
    cors({
      origin: true,
      credentials: true,
    })
  );
  app.use(express.json());

  const apiRouter = createRouter(db);
  app.use("/api", apiRouter);

  // Serve frontend static files in production
  const frontendDist = path.join(__dirname, "..", "frontend", "dist");
  app.use(express.static(frontendDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });

  startExpirySweep(db, 1000);

  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
