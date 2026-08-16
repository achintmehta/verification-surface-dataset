const express = require("express");
const cors = require("cors");
const path = require("path");
const { getDb } = require("./db");
const routes = require("./routes");

const PORT = process.env.PORT || 3000;

async function main() {
  // Initialize the database before starting the server
  await getDb();
  console.log("Database initialized.");

  const app = express();

  app.use(cors());
  app.use(express.json());

  // API routes
  app.use("/api", routes);

  // Serve the client build in production
  const clientDist = path.join(__dirname, "..", "client", "dist");
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
