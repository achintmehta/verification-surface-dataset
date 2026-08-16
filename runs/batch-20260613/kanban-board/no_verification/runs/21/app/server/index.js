const express = require("express");
const cors = require("cors");
const path = require("path");
const { getDb } = require("./db");
const routes = require("./routes");

const PORT = process.env.PORT || 3000;

async function main() {
  // Initialize DB before starting server
  await getDb();
  console.log("PGLite database initialized.");

  const app = express();

  app.use(cors());
  app.use(express.json());

  // Serve static frontend in production
  const clientDist = path.join(__dirname, "..", "client", "dist");
  app.use(express.static(clientDist));

  // API routes
  app.use("/api", routes);

  // SPA fallback
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });

  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
