import express from "express";
import cors from "cors";
import { initDb } from "./db.js";
import routes from "./routes.js";
import { startPeriodicSweep } from "./expiry.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Mount API routes
app.use("/api", routes);

// Serve frontend static files in production
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "..", "frontend")));

let server;

export async function startServer(port) {
  const actualPort = port || PORT;
  await initDb();
  startPeriodicSweep(1000);

  return new Promise((resolve) => {
    server = app.listen(actualPort, () => {
      console.log(`Seat booking server running on port ${actualPort}`);
      resolve(server);
    });
  });
}

export { app };

// Start if run directly
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("server.js") ||
    process.argv[1].endsWith("backend/server.js"));

if (isDirectRun) {
  startServer().catch(console.error);
}
