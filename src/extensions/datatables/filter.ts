/**
 * Compiles data table filters and sorts into SQL over the JSON row store.
 *
 * Column values are addressed with `json_extract(data, ?)` where the JSON path
 * is a bound parameter. Column keys are additionally validated against the
 * table schema, so neither keys nor values are ever spliced into SQL text.
 *
 * @module
 */

import { type SQL, sql } from "drizzle-orm";
import { coerceToType, isEmpty } from "./coerce";
import { DataTableError } from "./errors";
import { dataTableRows } from "./schema";
import {
  type ColumnDef,
  FILTER_OPS,
  type Filter,
  type FilterOp,
  META_COLUMNS,
  type Sort,
  VALUELESS_OPS,
} from "./types";

/** Maps metadata pseudo-columns to physical columns. */
const META_SQL: Record<(typeof META_COLUMNS)[number], SQL> = {
  _id: sql`${dataTableRows.id}`,
  _createdAt: sql`${dataTableRows.createdAt}`,
  _updatedAt: sql`${dataTableRows.updatedAt}`,
};

/**
 * Builds the JSON path for a column key.
 *
 * @param key - A validated column key
 * @returns The JSON path (`$."key"`)
 */
export function jsonPath(key: string): string {
  return `$."${key}"`;
}

/** A resolved filter/sort target: the SQL expression plus its column (absent for metadata). */
interface ColumnRef {
  expr: SQL;
  column?: ColumnDef;
}

/**
 * Resolves a column key (or metadata column) to a SQL expression.
 *
 * @param columns - The table's columns
 * @param key - The requested column key
 * @returns The SQL expression and column definition
 * @throws {DataTableError} 400 when the column does not exist
 */
function resolveColumn(columns: readonly ColumnDef[], key: string): ColumnRef {
  if ((META_COLUMNS as readonly string[]).includes(key)) {
    return { expr: META_SQL[key as (typeof META_COLUMNS)[number]] };
  }
  const column = columns.find((c) => c.key === key);
  if (!column) throw new DataTableError(400, `Unknown column "${key}"`);
  return { expr: sql`json_extract(${dataTableRows.data}, ${jsonPath(key)})`, column };
}

/**
 * Converts a filter operand to the representation `json_extract` returns for
 * the column type (booleans as 0/1, objects as JSON text).
 *
 * @param ref - The resolved column
 * @param raw - The raw operand
 * @returns The SQL-bindable operand
 * @throws {DataTableError} 400 when the operand cannot be coerced
 */
function toSqlOperand(ref: ColumnRef, raw: unknown): string | number | null {
  if (isEmpty(raw)) return null;
  const type = ref.column ? ref.column.type : "number";
  const result = coerceToType(type, raw);
  if (!result.ok) throw new DataTableError(400, `Filter on "${ref.column?.key ?? "metadata"}": ${result.error}`);
  const value = result.value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Escapes `LIKE` wildcards in a literal.
 *
 * @param s - The literal
 * @returns The escaped literal (escape character `\`)
 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Splits an `in` operand into its items.
 *
 * @param raw - An array or comma-separated string
 * @returns The individual items
 */
function inItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") return raw.split(",").map((s) => s.trim());
  return [raw];
}

/**
 * Compiles a single filter condition.
 *
 * @param columns - The table's columns
 * @param filter - The condition
 * @returns The SQL condition
 * @throws {DataTableError} 400 for unknown columns/operators or invalid operands
 */
function compileFilter(columns: readonly ColumnDef[], filter: Filter): SQL {
  if (!(FILTER_OPS as readonly string[]).includes(filter.op)) {
    throw new DataTableError(400, `Unknown filter operator "${filter.op}"`);
  }
  const ref = resolveColumn(columns, filter.column);
  const op: FilterOp = filter.op;
  if (VALUELESS_OPS.includes(op)) {
    return op === "isNull" ? sql`${ref.expr} IS NULL` : sql`${ref.expr} IS NOT NULL`;
  }
  if (op === "contains" || op === "startsWith") {
    const text = isEmpty(filter.value) ? "" : String(filter.value);
    const pattern = op === "contains" ? `%${escapeLike(text)}%` : `${escapeLike(text)}%`;
    return sql`CAST(${ref.expr} AS TEXT) LIKE ${pattern} ESCAPE '\\'`;
  }
  if (op === "in") {
    const items = inItems(filter.value).map((item) => toSqlOperand(ref, item));
    if (items.length === 0) return sql`0`;
    return sql`${ref.expr} IN (${sql.join(
      items.map((i) => sql`${i}`),
      sql`, `,
    )})`;
  }
  const operand = toSqlOperand(ref, filter.value);
  if (operand === null) {
    if (op === "eq") return sql`${ref.expr} IS NULL`;
    if (op === "ne") return sql`${ref.expr} IS NOT NULL`;
    throw new DataTableError(400, `Filter "${op}" on "${filter.column}" needs a value`);
  }
  switch (op) {
    case "eq":
      return sql`${ref.expr} = ${operand}`;
    case "ne":
      return sql`${ref.expr} IS NOT ${operand}`;
    case "lt":
      return sql`${ref.expr} < ${operand}`;
    case "lte":
      return sql`${ref.expr} <= ${operand}`;
    case "gt":
      return sql`${ref.expr} > ${operand}`;
    default:
      return sql`${ref.expr} >= ${operand}`;
  }
}

/**
 * Compiles AND-combined filters for one table.
 *
 * @param tableId - The table id (always constrains the result)
 * @param columns - The table's columns
 * @param filters - The conditions
 * @returns The SQL `WHERE` condition
 * @throws {DataTableError} 400 for invalid filters
 */
export function buildWhere(tableId: string, columns: readonly ColumnDef[], filters: readonly Filter[] = []): SQL {
  const parts = [sql`${dataTableRows.tableId} = ${tableId}`, ...filters.map((f) => compileFilter(columns, f))];
  return sql.join(parts, sql` AND `);
}

/**
 * Compiles a sort specification. Rows are always tie-broken by id so paging is stable.
 *
 * @param columns - The table's columns
 * @param sort - Optional sort specification
 * @returns The SQL `ORDER BY` expression list
 * @throws {DataTableError} 400 for unknown columns
 */
export function buildOrderBy(columns: readonly ColumnDef[], sort?: Sort): SQL {
  if (!sort) return sql`${dataTableRows.id} ASC`;
  const ref = resolveColumn(columns, sort.column);
  const dir = sort.desc ? sql`DESC` : sql`ASC`;
  const expr = ref.column?.type === "text" ? sql`${ref.expr} COLLATE NOCASE` : ref.expr;
  return sql`${expr} ${dir} NULLS LAST, ${dataTableRows.id} ASC`;
}
