const express = require("express");
const cors = require("cors");
const path = require("path");
const { getDb } = require("./db");
const boardRouter = require("./routes/board");
const cardsRouter = require("./routes/cards");
const streamRouter = require("./routes/stream");

const PORT = process.env.PORT || 3000;

async function main() {
  // Ensure DB is initialized before starting the server
  await getDb();
  console.log("PGLite database initialized.");

  const app = express();

  app.use(cors());
  app.use(express.json());

  // API routes
  app.use("/api", boardRouter);
  app.use("/api", cardsRouter);
  app.use("/api", streamRouter);

  // In production, serve the built frontend
  if (process.env.NODE_ENV === "production") {
    const clientDist = path.join(__dirname, "..", "client", "dist");
    app.use(express.static(clientDist));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
