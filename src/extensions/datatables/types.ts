/**
 * Data Tables shared types and constants.
 *
 * Pure type/constant module with no runtime dependencies so it can be imported
 * from the backend, the sandbox program, and the extension's Svelte pages.
 *
 * @module
 */

/** Supported column types. */
export const COLUMN_TYPES = ["text", "number", "integer", "boolean", "date", "datetime", "json"] as const;

/** A column's value type. */
export type ColumnType = (typeof COLUMN_TYPES)[number];

/** Human-readable labels for {@link COLUMN_TYPES}. */
export const COLUMN_TYPE_LABELS: Readonly<Record<ColumnType, string>> = {
  text: "Text",
  number: "Number",
  integer: "Integer",
  boolean: "Boolean",
  date: "Date",
  datetime: "Date & time",
  json: "JSON",
};

/** Table name pattern (also used in URLs, workflow steps, and the CLI). */
export const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** Column key pattern. Keys never start with `_`, which is reserved for row metadata. */
export const COLUMN_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Converts free text (a header or label) to a column/table key base:
 * lowercase ASCII, German umlauts transliterated, other characters collapsed
 * to `_`. May return an empty string or one starting with a digit.
 *
 * @param text - Source text
 * @returns The slug (at most 56 characters)
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 56);
}

/** Maximum number of columns per table. */
export const MAX_COLUMNS = 100;

/** A single column definition. */
export interface ColumnDef {
  /** Stable key used in row data, filters, and templates. */
  key: string;
  /** Display label. */
  label: string;
  /** Value type; all writes are coerced to it. */
  type: ColumnType;
  /** Reject rows where this column is empty. */
  required?: boolean;
  /** Reject rows whose (non-empty) value already exists in another row. */
  unique?: boolean;
  /** Value used when a new row omits this column. */
  default?: unknown;
}

/** A table definition as returned by the API. */
export interface TableDef {
  /** UUID identifier. */
  id: string;
  /** Unique slug. */
  name: string;
  /** Display name. */
  label: string;
  /** Optional description. */
  description?: string;
  /** Ordered column definitions. */
  columns: ColumnDef[];
  /** Column key that identifies a row for upserts. */
  keyColumn?: string;
  /** Id of the creating user. */
  createdByUserId?: string;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
  /** Last change timestamp (epoch ms). */
  updatedAt: number;
}

/** A table definition plus its row count (list endpoint). */
export interface TableSummary extends TableDef {
  /** Number of rows in the table. */
  rowCount: number;
}

/**
 * A row as returned by queries: column values plus reserved `_`-prefixed
 * metadata fields.
 */
export type RowRecord = {
  /** Stable row id. */
  _id: number;
  /** Creation timestamp (epoch ms). */
  _createdAt: number;
  /** Last update timestamp (epoch ms). */
  _updatedAt: number;
} & Record<string, unknown>;

/** Metadata pseudo-columns that can be filtered and sorted on. */
export const META_COLUMNS = ["_id", "_createdAt", "_updatedAt"] as const;

/** Supported filter operators. */
export const FILTER_OPS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "startsWith",
  "in",
  "isNull",
  "notNull",
] as const;

/** A filter operator. */
export type FilterOp = (typeof FILTER_OPS)[number];

/** Human-readable labels for {@link FILTER_OPS}. */
export const FILTER_OP_LABELS: Readonly<Record<FilterOp, string>> = {
  eq: "=",
  ne: "≠",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  contains: "contains",
  startsWith: "starts with",
  in: "in",
  isNull: "is empty",
  notNull: "is not empty",
};

/** Operators that take no value. */
export const VALUELESS_OPS: readonly FilterOp[] = ["isNull", "notNull"];

/** A single filter condition. Multiple conditions are AND-combined. */
export interface Filter {
  /** Column key (or a {@link META_COLUMNS} entry). */
  column: string;
  /** Comparison operator. */
  op: FilterOp;
  /** Comparison value; coerced to the column type. For `in`, an array or comma-separated string. */
  value?: unknown;
}

/** Sort specification. */
export interface Sort {
  /** Column key (or a {@link META_COLUMNS} entry). */
  column: string;
  /** Sort descending. */
  desc?: boolean;
}

/** Supported import/export file formats. */
export type FileFormat = "csv" | "xlsx";

/** Import modes. */
export const IMPORT_MODES = ["create", "append", "replace"] as const;

/** An import mode: create a new table, append to, or replace an existing one. */
export type ImportMode = (typeof IMPORT_MODES)[number];

/** Result of parsing an uploaded file for preview. */
export interface ImportPreview {
  /** Sheet names (XLSX) or `["csv"]`. */
  sheets: string[];
  /** The sheet the preview was built from. */
  sheet: string;
  /** Header cells (or generated `Column N` names when there is no header row). */
  headers: string[];
  /** Inferred columns, aligned with {@link headers}. */
  columns: ColumnDef[];
  /** First rows as display strings. */
  sampleRows: string[][];
  /** Total number of data rows. */
  totalRows: number;
}

/** A row-level problem reported by a write or import. */
export interface RowError {
  /** Zero-based index of the row in the submitted batch. */
  index: number;
  /** Error messages for the row. */
  errors: string[];
}

/** Result of an import. */
export interface ImportResult {
  /** The target table. */
  table: string;
  /** Number of rows inserted. */
  inserted: number;
  /** Rows skipped because they failed validation (capped sample). */
  skipped: RowError[];
  /** Total number of skipped rows. */
  skippedCount: number;
}

/** WebSocket UI event emitted after a table's schema or rows change. */
export const TABLE_CHANGED_EVENT = "table_changed";

/** Payload of {@link TABLE_CHANGED_EVENT}. */
export interface TableChangedEvent {
  /** Name of the changed table. */
  table: string;
  /** Whether the table was deleted. */
  deleted?: boolean;
}
