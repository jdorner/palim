/**
 * Drizzle ORM database connection.
 *
 * Provides a shared database instance backed by Bun's native SQLite driver.
 * The database file (`palim.db`) is co-located with the bunqueue database
 * so all queue data lives in the same directory.
 *
 * @module
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "@src/config";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import createLogger from "logging";
import * as schema from "./schema";

const logger = createLogger("Database");

/** Drizzle database instance type. */
export type AppDatabase = ReturnType<typeof drizzle<typeof schema>>;

/** Resolves the path to the drizzle migrations folder. */
function resolveMigrationsDir(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, "../../drizzle");
}

let _sqlite: Database | null = null;
let _db: AppDatabase | null = null;

/**
 * Get or create the shared Drizzle database instance.
 *
 * On first call, opens the SQLite file with WAL mode and runs
 * any pending Drizzle migrations.
 *
 * @returns The shared Drizzle database instance
 */
export function getDb(): AppDatabase {
  if (!_db) {
    mkdirSync(DATA_DIR, { recursive: true });
    const dbPath = join(DATA_DIR, "palim.db");

    _sqlite = new Database(dbPath, { create: true });
    _sqlite.run("PRAGMA journal_mode = WAL");
    _sqlite.run("PRAGMA synchronous = NORMAL");

    _db = drizzle(_sqlite, { schema });

    // Run pending migrations on startup
    migrate(_db, { migrationsFolder: resolveMigrationsDir() });

    logger.debug(`Database opened at ${dbPath}`);
  }
  return _db;
}

/**
 * Close the shared database connection (for graceful shutdown).
 */
export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
    logger.debug("Database closed");
  }
}

export * as appConfig from "./appConfig";
export { schema };
