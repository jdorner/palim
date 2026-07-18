/**
 * File watcher extension database schema.
 *
 * Defines the `ext_filewatcher_watchers` table for persisting
 * directory watcher registrations.
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * File watcher registrations.
 *
 * Configurable directory watchers that emit domain events when matching
 * files are detected, enabling file system events as workflow triggers.
 */
export const fileWatchers = sqliteTable("ext_filewatcher_watchers", {
  /** URL-safe slug - used as the trigger ref in workflow YAML. */
  slug: text("slug").primaryKey(),
  /** Human-readable label. */
  name: text("name").notNull(),
  /** Directory path relative to WORK_DIR (e.g. "inbox"). */
  path: text("path").notNull(),
  /** JSON-encoded array of glob patterns (e.g. '["*.png","*.pdf"]'). */
  patterns: text("patterns").notNull(),
  /** JSON-encoded array of event types to watch for (e.g. '["new","change"]'). */
  events: text("events").notNull().default('["new"]'),
  /** Whether to watch subdirectories recursively. */
  recursive: integer("recursive", { mode: "boolean" }).notNull().default(false),
  /** Whether to emit events for files already present when the watcher starts. */
  processExisting: integer("process_existing", { mode: "boolean" }).notNull().default(false),
  /** Whether this watcher is active. */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Creation timestamp (ms). */
  createdAt: integer("created_at").notNull(),
});
