/**
 * Data Tables extension database schema.
 *
 * Table definitions live in `ext_datatables_tables` (one row per user-defined
 * table, with its column definitions as JSON). Rows of every table share
 * `ext_datatables_rows`, each holding its cell values as a JSON object keyed by
 * column key. Keeping the physical schema fixed means user schema edits never
 * require runtime DDL; filtering and sorting go through `json_extract`.
 *
 * @module
 */

import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/** User-defined data table definitions. */
export const dataTables = sqliteTable(
  "ext_datatables_tables",
  {
    /** UUID table identifier. */
    id: text("id").primaryKey(),
    /** Unique slug used in URLs, workflow steps, and the CLI. */
    name: text("name").notNull(),
    /** Human-readable display name. */
    label: text("label").notNull(),
    /** Optional description. */
    description: text("description"),
    /** JSON-encoded `ColumnDef[]`. */
    columns: text("columns").notNull(),
    /** Column key identifying a row for upserts (null = none). */
    keyColumn: text("key_column"),
    /** Id of the user who created the table (null for system-created tables). */
    createdByUserId: text("created_by_user_id"),
    /** Creation timestamp (epoch ms). */
    createdAt: integer("created_at").notNull(),
    /** Last schema or data change timestamp (epoch ms). */
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [unique("uq_ext_datatables_tables_name").on(table.name)],
);

/** Rows of all data tables, stored as JSON objects. */
export const dataTableRows = sqliteTable(
  "ext_datatables_rows",
  {
    /** Auto-incrementing row id (stable across edits). */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Owning table id ({@link dataTables}.id). */
    tableId: text("table_id").notNull(),
    /** JSON-encoded cell values keyed by column key. */
    data: text("data").notNull(),
    /** Creation timestamp (epoch ms). */
    createdAt: integer("created_at").notNull(),
    /** Last update timestamp (epoch ms). */
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_ext_datatables_rows_table").on(table.tableId, table.id)],
);
