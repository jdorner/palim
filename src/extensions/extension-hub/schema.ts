/**
 * Extension Hub database schema.
 *
 * Sources are git repositories holding extensions (one folder per extension).
 * Installs record every extension the hub placed in the external extensions
 * directory; folders without a row are local and never touched by the hub.
 * Install records live in the database, not next to the extension files,
 * because the sandboxed agent can write below the data directory.
 *
 * @module
 */

import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/** Registered extension source repositories. */
export const hubSources = sqliteTable(
  "ext_extension_hub_sources",
  {
    /** UUID source identifier (also names the local mirror). */
    id: text("id").primaryKey(),
    /** Unique display name. */
    name: text("name").notNull(),
    /** Git remote URL (ssh, https, or file). */
    url: text("url").notNull(),
    /** Branch offered as "latest development" (null = the remote's default branch). */
    branch: text("branch"),
    /** Creation timestamp (epoch ms). */
    createdAt: integer("created_at").notNull(),
    /** Last change timestamp (epoch ms). */
    updatedAt: integer("updated_at").notNull(),
    /** Last successful fetch (epoch ms, null = never). */
    lastFetchedAt: integer("last_fetched_at"),
    /** Error of the last fetch attempt (null = it succeeded). */
    lastError: text("last_error"),
  },
  (table) => [unique("uq_ext_extension_hub_sources_name").on(table.name)],
);

/** Extensions installed by the hub, keyed by folder (= package) name. */
export const hubInstalls = sqliteTable("ext_extension_hub_installs", {
  /** Folder name below the external extensions directory (= package.json name). */
  name: text("name").primaryKey(),
  /** Source the extension was installed from. */
  sourceId: text("source_id").notNull(),
  /** Requested ref: tag name, branch name, or commit SHA. */
  ref: text("ref").notNull(),
  /** How `ref` is followed by update checks: `tag`, `branch`, or `commit` (pinned). */
  refKind: text("ref_kind").notNull(),
  /** package.json version of the installed tree. */
  version: text("version").notNull(),
  /** Installed commit SHA. */
  commit: text("commit").notNull(),
  /** Hash of the installed files, to detect local modifications. */
  contentHash: text("content_hash").notNull(),
  /** Install or last update timestamp (epoch ms). */
  installedAt: integer("installed_at").notNull(),
  /** User who installed or last updated it (null = system). */
  installedBy: text("installed_by"),
});
