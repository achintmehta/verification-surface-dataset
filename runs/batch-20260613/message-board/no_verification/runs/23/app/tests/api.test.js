import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { setDb } from "../server/db.js";
import app from "../server/app.js";

describe("API routes", () => {
  beforeAll(async () => {
    const memDb = new PGlite();
    await memDb.waitReady;
    await setDb(memDb);
  });

  // ---------------------------------------------------------------
  //  GET /api/messages
  // ---------------------------------------------------------------
  describe("GET /api/messages", () => {
    it("should return an empty array initially", async () => {
      const res = await request(app).get("/api/messages");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  // ---------------------------------------------------------------
  //  POST /api/messages
  // ---------------------------------------------------------------
  describe("POST /api/messages", () => {
    it("should create a message and return 201", async () => {
      const res = await request(app)
        .post("/api/messages")
        .send({ text: "Test message" });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.text).toBe("Test message");
      expect(res.body).toHaveProperty("created_at");
    });

    it("should trim whitespace from message text", async () => {
      const res = await request(app)
        .post("/api/messages")
        .send({ text: "  spaced out  " });

      expect(res.status).toBe(201);
      expect(res.body.text).toBe("spaced out");
    });

    it("should return 400 when text is missing", async () => {
      const res = await request(app).post("/api/messages").send({});
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("should return 400 when text is empty string", async () => {
      const res = await request(app)
        .post("/api/messages")
        .send({ text: "" });
      expect(res.status).toBe(400);
    });

    it("should return 400 when text is only whitespace", async () => {
      const res = await request(app)
        .post("/api/messages")
        .send({ text: "   " });
      expect(res.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------
  //  History after inserts
  // ---------------------------------------------------------------
  describe("GET /api/messages after inserts", () => {
    it("should return previously created messages", async () => {
      const res = await request(app).get("/api/messages");
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
      expect(res.body[0]).toHaveProperty("id");
      expect(res.body[0]).toHaveProperty("text");
      expect(res.body[0]).toHaveProperty("created_at");
    });
  });

  // ---------------------------------------------------------------
  //  SSE stream
  // ---------------------------------------------------------------
  describe("GET /api/stream", () => {
    it("should return text/event-stream content type", async () => {
      const res = await request(app)
        .get("/api/stream")
        .buffer(true)
        .parse((res, callback) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk.toString();
            // End after first chunk – we just need to check headers
            res.destroy();
          });
          res.on("end", () => callback(null, data));
          res.on("error", callback);
          // Safety timeout
          setTimeout(() => {
            res.destroy();
            callback(null, data);
          }, 1000);
        });

      expect(res.headers["content-type"]).toBe("text/event-stream");
    });
  });
});
