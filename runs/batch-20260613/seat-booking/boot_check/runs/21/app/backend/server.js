import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { initDb } from "./db.js";
import { expireStaleHolds } from "./expiry.js";
import routes from "./routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// API routes
app.use("/api", routes);

// Serve frontend static files in production
const frontendDist = path.join(__dirname, "..", "frontend", "dist");
app.use(express.static(frontendDist));
app.get("*", (req, res) => {
  res.sendFile(path.join(frontendDist, "index.html"));
});

// Start server
async function start() {
  try {
    await initDb();
    console.log("Database initialized.");

    // Periodic sweep for expired holds every 5 seconds
    setInterval(async () => {
      try {
        await expireStaleHolds();
      } catch (err) {
        console.error("Expiry sweep error:", err);
      }
    }, 5000);

    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
