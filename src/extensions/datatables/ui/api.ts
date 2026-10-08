/**
 * Small API helpers for the Data Tables pages.
 *
 * Unlike `palim.json`, errors keep the server's `details` (row errors), which
 * the schema editor and import dialog display.
 */

import type { PalimHost } from "@ext/ui";
import type { ColumnDef, Filter, RowError } from "../types";

/** Base app route of the Data Tables page. */
export const PAGE_ROUTE = "/ext-page/datatables/tables";

/** An API error with optional row-level details. */
export class ApiError extends Error {
  readonly status: number;
  readonly rows: RowError[];
  readonly count: number;

  constructor(status: number, message: string, details?: { rows?: RowError[]; count?: number }) {
    super(message);
    this.status = status;
    this.rows = details?.rows ?? [];
    this.count = details?.count ?? this.rows.length;
  }
}

/**
 * Performs a request and parses the JSON response.
 *
 * @param palim - Host API
 * @param path - Extension-relative path
 * @param init - Method and body (objects are JSON-encoded, FormData is sent as is)
 * @returns The parsed body
 * @throws {ApiError} On non-2xx responses
 */
export async function request<T>(
  palim: PalimHost,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const isForm = init.body instanceof FormData;
  const res = await palim.fetch(path, {
    method: init.method ?? "GET",
    headers: init.body !== undefined && !isForm ? { "content-type": "application/json" } : undefined,
    body: init.body === undefined ? undefined : isForm ? (init.body as FormData) : JSON.stringify(init.body),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // non-JSON body
  }
  if (!res.ok) {
    throw new ApiError(res.status, String(data.error ?? `HTTP ${res.status}`), data.details as never);
  }
  return data as T;
}

/**
 * Builds the `filter`/`sort` query string for row queries and exports.
 *
 * @param filters - Active filters
 * @param sort - Active sort
 * @returns URL search params
 */
export function queryParams(filters: Filter[], sort?: { column: string; desc: boolean }): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.length > 0) params.set("filter", JSON.stringify(filters));
  if (sort) {
    params.set("sort", sort.column);
    if (sort.desc) params.set("desc", "true");
  }
  return params;
}

/**
 * Error message helper.
 *
 * @param err - Any thrown value
 * @returns A message
 */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Formats a stored value for display.
 *
 * @param column - Column definition
 * @param value - Stored value
 * @returns Display text (`""` for empty)
 */
export function displayValue(column: ColumnDef, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (column.type === "boolean") return value ? "✓" : "✗";
  if (column.type === "datetime" && typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
  }
  if (column.type === "number" && typeof value === "number") return value.toLocaleString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Shared input classes. */
export const INPUT_CLASS =
  "w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

/** A column being edited in the UI. */
export interface EditableColumn extends ColumnDef {
  /** Stable client-side id (for keyed lists). */
  uid: string;
  /** Key of the stored column this one was loaded from (edit mode; drives renames). */
  originalKey?: string;
  /** Whether the key still follows the label automatically. */
  autoKey?: boolean;
  /** Source file column index (import mode); `null` = no source. */
  source?: number | null;
}

let uidCounter = 0;

/**
 * Creates a client-side id.
 *
 * @returns A unique id
 */
export function nextUid(): string {
  uidCounter += 1;
  return `c${uidCounter}`;
}

/**
 * Converts stored columns to editable columns.
 *
 * @param columns - Stored columns
 * @param fromStore - Whether the columns exist in the database (enables rename tracking)
 * @returns Editable columns
 */
export function toEditable(columns: ColumnDef[], fromStore: boolean): EditableColumn[] {
  return columns.map((c, i) => ({
    ...c,
    uid: nextUid(),
    originalKey: fromStore ? c.key : undefined,
    autoKey: !fromStore,
    source: fromStore ? undefined : i,
  }));
}

/**
 * Strips UI-only fields from editable columns.
 *
 * @param columns - Editable columns
 * @returns Column definitions for the API
 */
export function toColumnDefs(columns: EditableColumn[]): ColumnDef[] {
  return columns.map((c) => {
    const def: ColumnDef = { key: c.key.trim(), label: c.label.trim() || c.key.trim(), type: c.type };
    if (c.required) def.required = true;
    if (c.unique) def.unique = true;
    if (c.default !== undefined && c.default !== null && c.default !== "") def.default = c.default;
    return def;
  });
}
