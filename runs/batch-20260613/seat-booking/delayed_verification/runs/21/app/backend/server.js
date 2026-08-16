const express = require("express");
const cors = require("cors");
const path = require("path");
const { initDb } = require("./db");
const routes = require("./routes");
const { startPeriodicSweep } = require("./expiry");

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json());

// Serve static frontend in production
app.use(express.static(path.join(__dirname, "..", "frontend")));

// API routes
app.use("/api", routes);

// Fallback to index.html for SPA
app.get("*", (req, res) => {
  if (!req.path.startsWith("/api")) {
    res.sendFile(path.join(__dirname, "..", "frontend", "index.html"));
  }
});

async function start() {
  try {
    await initDb();
    console.log("Database initialized");

    // Start periodic hold expiry sweep every 1 second
    startPeriodicSweep(1000);
    console.log("Periodic hold expiry sweep started");

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();

module.exports = app;
