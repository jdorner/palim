import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@src/auth/testDb";
import { findWebhook, initStore, insertWebhook, updateWebhookRecord } from "./store";

describe("webhook store", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    initStore(testDb.db as never);
  });

  afterEach(() => {
    testDb.sqlite.close();
  });

  test("an update persists a re-bound owner", () => {
    insertWebhook({
      slug: "hook",
      name: "Hook",
      authType: "bearer",
      secret: "12345678",
      headerName: "Authorization",
      enabled: true,
      createdAt: 0,
      createdByUserId: "alice",
    });

    updateWebhookRecord("hook", { name: "Renamed", createdByUserId: "bob" });

    const stored = findWebhook("hook");
    expect(stored?.name).toBe("Renamed");
    expect(stored?.createdByUserId).toBe("bob");
  });
});
