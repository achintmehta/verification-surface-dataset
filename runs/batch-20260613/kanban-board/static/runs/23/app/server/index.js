import express from "express";
import cors from "cors";
import { getDb } from "./db.js";
import routes from "./routes.js";

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// Mount API routes
app.use("/api", routes);

async function main() {
  // Eagerly initialise the database so the schema is ready before requests arrive
  await getDb();
  console.log("Database initialised.");

  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
