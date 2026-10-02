import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@src/db/schema";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

/** Resolves the top-level drizzle migrations folder (same logic as src/db/index.ts). */
function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../drizzle");
}

describe("migration 0010 (user management)", () => {
  let dir: string;
  let sqlite: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "palim-migrate-"));
    sqlite = new Database(join(dir, "test.db"), { create: true });
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: migrationsDir() });
  });

  afterEach(() => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Reads the set of table names present in the database. */
  function tableNames(): Set<string> {
    const rows = sqlite.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    return new Set(rows.map((r) => r.name));
  }

  /** Reads the set of column names for a given table. */
  function columnNames(table: string): Set<string> {
    const rows = sqlite.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    return new Set(rows.map((r) => r.name));
  }

  test("creates the auth tables", () => {
    const tables = tableNames();
    expect(tables.has("users")).toBe(true);
    expect(tables.has("roles")).toBe(true);
    expect(tables.has("role_permissions")).toBe(true);
    expect(tables.has("user_roles")).toBe(true);
    expect(tables.has("user_sessions")).toBe(true);
  });

  test("adds user_id to sessions", () => {
    expect(columnNames("sessions").has("user_id")).toBe(true);
  });

  test("adds created_by_user_id to trigger tables", () => {
    expect(columnNames("ext_filewatcher_watchers").has("created_by_user_id")).toBe(true);
    expect(columnNames("ext_webhooks_registrations").has("created_by_user_id")).toBe(true);
  });

  test("adds created_by_user_id to workflow_runs (migration 0011)", () => {
    expect(columnNames("workflow_runs").has("created_by_user_id")).toBe(true);
  });

  test("enforces unique username", () => {
    const now = Date.now();
    sqlite.run(
      "INSERT INTO users (id, username, password_hash, provider, disabled, created_at, updated_at) VALUES (?, ?, ?, 'local', 0, ?, ?)",
      ["u1", "alice", "hash", now, now],
    );
    expect(() =>
      sqlite.run(
        "INSERT INTO users (id, username, password_hash, provider, disabled, created_at, updated_at) VALUES (?, ?, ?, 'local', 0, ?, ?)",
        ["u2", "alice", "hash2", now, now],
      ),
    ).toThrow();
  });

  test("all migrations apply idempotently on a fresh db without error", () => {
    // A second migrate() call on the same DB must be a no-op (already applied).
    const db = drizzle(sqlite, { schema });
    expect(() => migrate(db, { migrationsFolder: migrationsDir() })).not.toThrow();
  });
});
