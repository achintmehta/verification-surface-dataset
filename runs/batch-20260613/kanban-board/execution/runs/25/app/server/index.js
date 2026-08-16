import express from "express";
import cors from "cors";
import { getDb } from "./db.js";
import routes from "./routes.js";

const PORT = process.env.PORT || 3000;

const app = express();

app.use(cors());
app.use(express.json());

// Mount API routes
app.use("/api", routes);

// Initialize DB then start server
getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Kanban server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
