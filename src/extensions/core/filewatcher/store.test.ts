import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@src/auth/testDb";
import { findWatcher, initStore, insertWatcher, updateWatcher } from "./store";

describe("file watcher store", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    initStore(testDb.db as never);
  });

  afterEach(() => {
    testDb.sqlite.close();
  });

  test("an update persists a re-bound owner", () => {
    insertWatcher({
      slug: "inbox",
      name: "Inbox",
      path: "inbox",
      patterns: ["*.pdf"],
      events: ["new"],
      recursive: false,
      processExisting: false,
      enabled: true,
      createdAt: 0,
      createdByUserId: "alice",
    });

    updateWatcher("inbox", { recursive: true, createdByUserId: "bob" });

    const stored = findWatcher("inbox");
    expect(stored?.recursive).toBe(true);
    expect(stored?.createdByUserId).toBe("bob");
  });
});
