import express from "express";
import cors from "cors";
import router from "./routes.js";
import { getDb } from "./db.js";

const PORT = process.env.PORT ?? 3000;

const app = express();

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Routes ──────────────────────────────────────────────────────────────────
app.use(router);

// ── Start ───────────────────────────────────────────────────────────────────
async function start() {
  // Ensure the database is initialised before accepting requests.
  await getDb();
  console.log("PGLite database initialised.");

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
