/**
 * Drizzle ORM schema for the global variables table.
 *
 * Stores plaintext, non-sensitive key-value pairs scoped globally. Unlike the
 * secrets vault, values are stored in plaintext with no encryption, no per-row
 * ACL, and no key versioning.
 *
 * @module
 */

import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/**
 * SQLite table for plaintext global variables.
 *
 * Each row holds a single variable identified by a unique key. Values are
 * stored in plaintext (non-sensitive by design): no encryption, no ACL.
 */
export const globalVariables = sqliteTable(
  "global_variables",
  {
    /** Auto-incrementing primary key. */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The unique variable identifier (UPPER_SNAKE_CASE). */
    variableKey: text("variable_key").notNull(),
    /** The plaintext variable value. */
    value: text("value").notNull(),
    /** Optional human-readable description. */
    description: text("description"),
    /** Epoch timestamp (ms) when the variable was created. */
    createdAt: integer("created_at").notNull(),
    /** Epoch timestamp (ms) when the variable was last updated. */
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [unique("uq_global_variables_key").on(table.variableKey)],
);
