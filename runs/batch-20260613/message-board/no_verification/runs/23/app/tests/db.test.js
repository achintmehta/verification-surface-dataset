import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, insertMessage, getMessages } from "../server/db.js";

describe("Database layer", () => {
  beforeAll(async () => {
    // Use an in-memory PGLite instance for tests
    const memDb = new PGlite();
    await memDb.waitReady;
    await setDb(memDb);
  });

  it("should start with an empty messages table", async () => {
    const messages = await getMessages();
    expect(messages).toEqual([]);
  });

  it("should insert a message and return it with id and created_at", async () => {
    const msg = await insertMessage("Hello, world!");
    expect(msg).toHaveProperty("id");
    expect(msg).toHaveProperty("created_at");
    expect(msg.text).toBe("Hello, world!");
  });

  it("should retrieve messages in chronological order", async () => {
    // Insert a second message
    await insertMessage("Second message");

    const messages = await getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].text).toBe("Hello, world!");
    expect(messages[1].text).toBe("Second message");

    // Verify ordering by created_at
    const t0 = new Date(messages[0].created_at).getTime();
    const t1 = new Date(messages[1].created_at).getTime();
    expect(t1).toBeGreaterThanOrEqual(t0);
  });
});
