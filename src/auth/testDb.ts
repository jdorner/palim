/**
 * Test-only helper for constructing a migrated in-memory database.
 *
 * Shared across the auth module's tests so each suite gets a fresh, fully
 * migrated SQLite database without touching disk. Not part of the runtime API.
 *
 * @module
 */

import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@src/db/schema";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

/** A migrated in-memory database plus its raw SQLite handle for teardown. */
export interface TestDb {
  /** The Drizzle database instance. */
  db: ReturnType<typeof drizzle<typeof schema>>;
  /** The underlying SQLite handle (call `.close()` in afterEach). */
  sqlite: Database;
}

/** Resolves the top-level drizzle migrations folder. */
function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../drizzle");
}

/**
 * Creates a fresh in-memory database with all migrations applied.
 *
 * @returns The Drizzle instance and raw SQLite handle.
 */
export function createTestDb(): TestDb {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir() });
  return { db, sqlite };
}
