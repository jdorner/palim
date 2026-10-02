import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@src/db/schema";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { SessionStore } from "./sessionStore";

/** Resolves the top-level drizzle migrations folder. */
function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../drizzle");
}

describe("SessionStore ownership", () => {
  let sqlite: Database;
  let store: SessionStore;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: migrationsDir() });
    store = new SessionStore(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  test("create persists the owning userId", () => {
    const s = store.create({ source: "chat", sourceId: "c1", userId: "user-1" });
    expect(s.userId).toBe("user-1");
    expect(store.get(s.id)?.userId).toBe("user-1");
  });

  test("create without a userId leaves it null (system/ownerless)", () => {
    const s = store.create({ source: "scheduler", sourceId: "sch1" });
    expect(s.userId).toBeNull();
  });

  test("list filters by userId when provided", () => {
    store.create({ source: "chat", sourceId: "a", userId: "user-1" });
    store.create({ source: "chat", sourceId: "b", userId: "user-2" });
    store.create({ source: "chat", sourceId: "c", userId: "user-1" });

    const forUser1 = store.list({ userId: "user-1" });
    expect(forUser1.length).toBe(2);
    expect(forUser1.every((s) => s.userId === "user-1")).toBe(true);

    const all = store.list();
    expect(all.length).toBe(3);
  });

  test("getOrCreate applies userId only on creation", () => {
    const created = store.getOrCreate({ source: "chat", sourceId: "x", userId: "user-1" });
    expect(created.userId).toBe("user-1");
    // Second call finds the existing row; the userId argument is ignored.
    const found = store.getOrCreate({ source: "chat", sourceId: "x", userId: "user-2" });
    expect(found.id).toBe(created.id);
    expect(found.userId).toBe("user-1");
  });
});
