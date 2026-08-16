import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import router from "./routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// --------------- Middleware ---------------
app.use(cors());
app.use(express.json());

// --------------- API Routes ---------------
app.use("/api", router);

// --------------- Static Files (production) ---------------
if (process.env.NODE_ENV === "production") {
  const clientDist = path.join(__dirname, "..", "client", "dist");
  app.use(express.static(clientDist));
  // SPA fallback
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// --------------- Error handler ---------------
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

export default app;
