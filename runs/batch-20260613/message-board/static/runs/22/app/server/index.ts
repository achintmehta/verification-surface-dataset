import express from "express";
import cors from "cors";
import { router } from "./routes.js";
import { getDB } from "./db.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function main(): Promise<void> {
  // Eagerly initialize the database so the table is ready before requests
  await getDB();
  console.log("[server] database initialized");

  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // API routes
  app.use("/api", router);

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});
