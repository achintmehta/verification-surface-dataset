import express from "express";
import cors from "cors";
import router from "./routes.js";
import { getDb } from "./db.js";

const PORT = process.env.PORT || 3001;

async function main(): Promise<void> {
  // Initialize the database
  await getDb();
  console.log("Database initialized");

  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(router);

  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
