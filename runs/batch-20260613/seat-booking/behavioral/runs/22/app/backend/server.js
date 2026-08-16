const express = require("express");
const cors = require("cors");
const path = require("path");
const { getDb } = require("./db");
const { expireAndBroadcast } = require("./expiry");
const routes = require("./routes");

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(cors());
app.use(express.json());

// API routes
app.use("/api", routes);

// Serve static frontend in production
app.use(express.static(path.join(__dirname, "..", "frontend", "dist")));

// Periodic hold expiry sweep (every 5 seconds)
let sweepInterval;

async function startServer() {
  // Ensure DB is initialized before starting
  await getDb();
  console.log("Database initialized");

  const server = app.listen(PORT, () => {
    console.log(`Seat booking server listening on port ${PORT}`);
  });

  // Start periodic expiry sweep
  sweepInterval = setInterval(async () => {
    try {
      const db = await getDb();
      await expireAndBroadcast(db);
    } catch (err) {
      console.error("Sweep error:", err);
    }
  }, 5000);

  return server;
}

// Only auto-start when run directly
if (require.main === module) {
  startServer().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}

module.exports = { app, startServer };
