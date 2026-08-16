import express from "express";
import cors from "cors";
import { initDatabase } from "./db.js";
import apiRoutes from "./routes.js";

const PORT = process.env.PORT || 3001;

async function main() {
  console.log("Initializing database...");
  const startBoot = Date.now();

  await initDatabase();

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/api", apiRoutes);

  app.listen(PORT, () => {
    const bootTime = ((Date.now() - startBoot) / 1000).toFixed(1);
    console.log(`Server ready on port ${PORT} (boot: ${bootTime}s)`);
  });
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
