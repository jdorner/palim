/**
 * Centralized test database helpers.
 *
 * Provides a single source of truth for in-memory SQLite test databases
 * using drizzle migrations. When the schema changes, only the migrations
 * in `drizzle/` need updating - all tests pick up the change automatically.
 *
 * Extension-specific helpers (wiki, invoice-scanner) are intentionally
 * omitted — those are non-core extensions with their own test setups.
 *
 * @module
 */

import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appConfig,
  extensionSettings,
  jobLogs,
  secretAuditLog,
  secretsVault,
  sessionMessages,
  sessions,
} from "@src/db/schema";
import { fileWatchers as extFilewatcherWatchers } from "@src/extensions/core/filewatcher/schema";
import { webhooks as extWebhooksRegistrations } from "@src/extensions/core/webhooks/schema";
import { initDagRunStore } from "@src/extensions/core/workflows/dagRunStore";
import { workflowRuns as extWorkflowRuns } from "@src/extensions/core/workflows/runSchema";
import { initSignalStore } from "@src/extensions/core/workflows/signalStore";
import { mcpServers as extMcpServers } from "@src/extensions/mcp/schema";
import { wikiEmbeddings as extWikiEmbeddings } from "@src/extensions/wiki/schema";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = resolve(__dirname, "../../drizzle");

/**
 * Full application schema for typed Drizzle queries.
 * Includes all tables from db/schema.ts and its re-exports.
 */
const schema = {
  jobLogs,
  extensionSettings,
  appConfig,
  sessions,
  sessionMessages,
  extFilewatcherWatchers,
  extWebhooksRegistrations,
  extWorkflowRuns,
  extMcpServers,
  extWikiEmbeddings,
  secretAuditLog,
  secretsVault,
} as const;

/**
 * Creates an in-memory SQLite database, runs all drizzle migrations,
 * and returns a Drizzle instance typed with the full application schema.
 */
export function createTestDb(): ReturnType<typeof drizzle<typeof schema>> {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db as ReturnType<typeof drizzle<typeof schema>>;
}

/**
 * Creates a test DB with workflow-specific store initialization.
 *
 * Calls `initDagRunStore` and `initSignalStore` so that the workflow modules
 * use this database instance for their queries.
 */
export function createWorkflowTestDb(): ReturnType<typeof drizzle<typeof schema>> {
  const db = createTestDb();
  initDagRunStore(db);
  initSignalStore(db);
  return db;
}
