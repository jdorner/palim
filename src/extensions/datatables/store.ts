/**
 * Data table store: table definitions and JSON rows in the shared database.
 *
 * All writes coerce values to the declared column types and enforce
 * `required`/`unique` constraints inside a single SQLite transaction (SQLite
 * serializes writers and Palim runs in one process, so the read-check-write
 * sequence is race-free without runtime DDL).
 *
 * @module
 */

import { and, count, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { coerceRow, coerceToType, coerceValue, isEmpty } from "./coerce";
import { DataTableError } from "./errors";
import { buildOrderBy, buildWhere, jsonPath } from "./filter";
import { dataTableRows, dataTables } from "./schema";
import {
  COLUMN_KEY_PATTERN,
  COLUMN_TYPES,
  type ColumnDef,
  type Filter,
  MAX_COLUMNS,
  type RowError,
  type RowRecord,
  type Sort,
  TABLE_NAME_PATTERN,
  type TableChangedEvent,
  type TableDef,
  type TableSummary,
} from "./types";

/** The shared Drizzle database type handed to extensions. */
export type DataTableDb = BunSQLiteDatabase<Record<string, unknown>>;

/** Maximum rows returned by a single query. */
export const MAX_QUERY_LIMIT = 1000;

/** Maximum number of row errors included in error details. */
const MAX_REPORTED_ERRORS = 20;

/** Rows inserted per INSERT statement. */
const INSERT_CHUNK = 500;

/** Input for {@link DataTableStore.createTable}. */
export interface CreateTableInput {
  /** Unique slug. */
  name: string;
  /** Display name (defaults to the name). */
  label?: string;
  /** Optional description. */
  description?: string;
  /** Column definitions. */
  columns: ColumnDef[];
  /** Optional key column for upserts. */
  keyColumn?: string;
}

/** Input for {@link DataTableStore.updateTable}. */
export interface UpdateTableInput {
  /** New display name. */
  label?: string;
  /** New description (empty string clears it). */
  description?: string;
  /** New column list (replaces the old one). */
  columns?: ColumnDef[];
  /** Renamed columns as `{ oldKey: newKey }`; other missing keys are dropped. */
  renames?: Record<string, string>;
  /** New key column (`null` clears it; omitted keeps it, following renames). */
  keyColumn?: string | null;
  /** Set values that cannot be converted to empty instead of rejecting the change. */
  force?: boolean;
}

/** Result of {@link DataTableStore.updateTable}. */
export interface UpdateTableResult {
  /** The updated table. */
  table: TableDef;
  /** Number of rows rewritten. */
  rowsRewritten: number;
  /** Number of values cleared because they could not be converted (only with `force`). */
  valuesCleared: number;
}

/** Row query options. */
export interface RowQuery {
  /** AND-combined filters. */
  filters?: Filter[];
  /** Sort specification. */
  sort?: Sort;
  /** Page size (default 100, max {@link MAX_QUERY_LIMIT}). */
  limit?: number;
  /** Rows to skip. */
  offset?: number;
}

/** Result of an insert. */
export interface InsertResult {
  /** Number of inserted rows. */
  inserted: number;
  /** Ids of the inserted rows, in input order. */
  ids: number[];
  /** Skipped rows (only with `skipInvalid`; capped sample). */
  skipped: RowError[];
  /** Total number of skipped rows. */
  skippedCount: number;
}

/** Result of an upsert. */
export interface UpsertResult {
  /** Number of inserted rows. */
  inserted: number;
  /** Number of updated rows. */
  updated: number;
  /** Ids of the affected rows, in input order. */
  ids: number[];
}

/** Store options. */
export interface DataTableStoreOptions {
  /** Called after every committed change. */
  onChange?: (event: TableChangedEvent) => void;
}

/** A pending row write: insert when `id` is undefined. */
interface PendingWrite {
  index: number;
  id?: number;
  data: Record<string, unknown>;
}

/**
 * Normalizes a value for uniqueness comparison, matching what `json_extract`
 * returns for stored values (booleans as 0/1, objects as JSON text).
 *
 * @param value - A coerced, non-null value or a `json_extract` result
 * @returns A comparison key
 */
function valueKey(value: unknown): string {
  if (typeof value === "boolean") return `n:${value ? 1 : 0}`;
  if (typeof value === "number") return `n:${value}`;
  if (typeof value === "string") return `s:${value}`;
  return `s:${JSON.stringify(value)}`;
}

/**
 * Builds a {@link DataTableError} for failed rows.
 *
 * @param rowErrors - All row errors
 * @param verb - What failed (for the message)
 * @returns The error (status 400)
 */
function rowValidationError(rowErrors: RowError[], verb = "validation"): DataTableError {
  const first = rowErrors[0];
  const message =
    rowErrors.length === 1 && first
      ? `Row ${first.index + 1} failed ${verb}: ${first.errors.join("; ")}`
      : `${rowErrors.length} rows failed ${verb}; first (row ${(first?.index ?? 0) + 1}): ${first?.errors.join("; ")}`;
  return new DataTableError(400, message, { rows: rowErrors.slice(0, MAX_REPORTED_ERRORS), count: rowErrors.length });
}

/**
 * Validates and normalizes a column list.
 *
 * Labels default to keys, `default` values are coerced, and the key column is
 * forced to `unique` + `required` so it identifies rows.
 *
 * @param columns - The raw columns
 * @param keyColumn - Optional key column
 * @returns The normalized columns
 * @throws {DataTableError} 400 when invalid
 */
export function normalizeColumns(columns: readonly ColumnDef[], keyColumn?: string | null): ColumnDef[] {
  if (columns.length === 0) throw new DataTableError(400, "A table needs at least one column");
  if (columns.length > MAX_COLUMNS) throw new DataTableError(400, `A table can have at most ${MAX_COLUMNS} columns`);
  const seen = new Set<string>();
  const result: ColumnDef[] = [];
  for (const col of columns) {
    if (!COLUMN_KEY_PATTERN.test(col.key)) {
      throw new DataTableError(
        400,
        `Invalid column key "${col.key}": use lowercase letters, digits, and underscores, starting with a letter`,
      );
    }
    if (seen.has(col.key)) throw new DataTableError(400, `Duplicate column key "${col.key}"`);
    seen.add(col.key);
    if (!(COLUMN_TYPES as readonly string[]).includes(col.type)) {
      throw new DataTableError(400, `Invalid type "${col.type}" for column "${col.key}"`);
    }
    const normalized: ColumnDef = { key: col.key, label: col.label?.trim() || col.key, type: col.type };
    const isKey = col.key === keyColumn;
    if (col.required || isKey) normalized.required = true;
    if (col.unique || isKey) normalized.unique = true;
    if (!isEmpty(col.default)) {
      const coerced = coerceValue(normalized, col.default);
      if (!coerced.ok) throw new DataTableError(400, `Invalid default for ${coerced.error}`);
      normalized.default = coerced.value;
    }
    result.push(normalized);
  }
  if (keyColumn && !seen.has(keyColumn)) throw new DataTableError(400, `Key column "${keyColumn}" does not exist`);
  return result;
}

/**
 * Persistent store for data tables.
 */
export class DataTableStore {
  readonly #db: DataTableDb;
  readonly #onChange: (event: TableChangedEvent) => void;

  /**
   * @param db - The shared Drizzle database (migration 0013 applied)
   * @param options - Change notification hook
   */
  constructor(db: DataTableDb, options: DataTableStoreOptions = {}) {
    this.#db = db;
    this.#onChange = options.onChange ?? (() => {});
  }

  // -------------------------------------------------------------------------
  // Tables
  // -------------------------------------------------------------------------

  /**
   * Lists all tables with their row counts, ordered by label.
   *
   * @returns The table summaries
   */
  listTables(): TableSummary[] {
    const counts = new Map(
      this.#db
        .select({ tableId: dataTableRows.tableId, n: count() })
        .from(dataTableRows)
        .groupBy(dataTableRows.tableId)
        .all()
        .map((r) => [r.tableId, r.n]),
    );
    return this.#db
      .select()
      .from(dataTables)
      .all()
      .map((row) => ({ ...this.#toTableDef(row), rowCount: counts.get(row.id) ?? 0 }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * Lists the names of all tables, sorted.
   *
   * @returns Table names
   */
  tableNames(): string[] {
    return this.#db
      .select({ name: dataTables.name })
      .from(dataTables)
      .all()
      .map((r) => r.name)
      .sort();
  }

  /**
   * Looks up a table by name.
   *
   * @param name - Table name
   * @returns The table, or `undefined`
   */
  getTable(name: string): TableDef | undefined {
    const row = this.#db.select().from(dataTables).where(eq(dataTables.name, name)).get();
    return row ? this.#toTableDef(row) : undefined;
  }

  /**
   * Looks up a table by name, throwing when it does not exist.
   *
   * @param name - Table name
   * @returns The table
   * @throws {DataTableError} 404 when missing
   */
  requireTable(name: string): TableDef {
    const table = this.getTable(name);
    if (!table) throw new DataTableError(404, `Table "${name}" not found`);
    return table;
  }

  /**
   * Counts the rows of a table.
   *
   * @param name - Table name
   * @returns The row count
   * @throws {DataTableError} 404 when the table is missing
   */
  rowCount(name: string): number {
    const table = this.requireTable(name);
    return this.#db.select({ n: count() }).from(dataTableRows).where(eq(dataTableRows.tableId, table.id)).get()?.n ?? 0;
  }

  /**
   * Creates a table.
   *
   * @param input - Name, label, description, columns, key column
   * @param userId - Creating user id
   * @returns The created table
   * @throws {DataTableError} 400 for invalid definitions, 409 when the name is taken
   */
  createTable(input: CreateTableInput, userId?: string): TableDef {
    if (!TABLE_NAME_PATTERN.test(input.name)) {
      throw new DataTableError(
        400,
        `Invalid table name "${input.name}": use lowercase letters, digits, "-" and "_", starting with a letter`,
      );
    }
    const columns = normalizeColumns(input.columns, input.keyColumn);
    if (this.getTable(input.name)) throw new DataTableError(409, `Table "${input.name}" already exists`);
    const now = Date.now();
    const row = {
      id: crypto.randomUUID(),
      name: input.name,
      label: input.label?.trim() || input.name,
      description: input.description?.trim() || null,
      columns: JSON.stringify(columns),
      keyColumn: input.keyColumn || null,
      createdByUserId: userId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.#db.insert(dataTables).values(row).run();
    this.#onChange({ table: input.name });
    return this.#toTableDef(row);
  }

  /**
   * Updates a table's metadata and/or columns, migrating existing rows.
   *
   * Renamed columns keep their values, dropped columns are removed from every
   * row, and values of columns whose type changed are converted. Values that
   * cannot be converted (or required columns left empty) reject the change
   * unless `force` is set, in which case they are cleared. Duplicates in a
   * newly unique column always reject the change.
   *
   * @param name - Table name
   * @param input - The changes
   * @returns The updated table and migration statistics
   * @throws {DataTableError} 400 for invalid definitions, 404 when missing, 409 on conversion conflicts
   */
  updateTable(name: string, input: UpdateTableInput): UpdateTableResult {
    return this.#db.transaction(() => {
      const table = this.requireTable(name);
      const renames = input.renames ?? {};
      let columns = table.columns;
      let keyColumn: string | null = table.keyColumn ?? null;
      let rowsRewritten = 0;
      let valuesCleared = 0;

      if (input.keyColumn !== undefined) keyColumn = input.keyColumn || null;
      else if (keyColumn && renames[keyColumn]) keyColumn = renames[keyColumn] ?? null;
      // Dropping the key column clears the key instead of failing.
      if (input.keyColumn === undefined && input.columns && !input.columns.some((c) => c.key === keyColumn)) {
        keyColumn = null;
      }

      if (input.columns) {
        columns = normalizeColumns(input.columns, keyColumn);
        const sourceOf = this.#resolveSources(table.columns, columns, renames);
        const migrated = this.#migrateRows(table, columns, sourceOf, input.force === true);
        rowsRewritten = migrated.rowsRewritten;
        valuesCleared = migrated.valuesCleared;
      } else if (keyColumn && !table.columns.some((c) => c.key === keyColumn)) {
        throw new DataTableError(400, `Key column "${keyColumn}" does not exist`);
      } else if (keyColumn !== (table.keyColumn ?? null)) {
        columns = normalizeColumns(table.columns, keyColumn);
        this.#migrateRows(table, columns, new Map(columns.map((c) => [c.key, c.key])), false);
      }

      const updatedAt = Date.now();
      const patch: Partial<typeof dataTables.$inferInsert> = {
        columns: JSON.stringify(columns),
        keyColumn,
        updatedAt,
      };
      if (input.label !== undefined) patch.label = input.label.trim() || table.name;
      if (input.description !== undefined) patch.description = input.description.trim() || null;
      this.#db.update(dataTables).set(patch).where(eq(dataTables.id, table.id)).run();
      this.#onChange({ table: name });
      return { table: this.requireTable(name), rowsRewritten, valuesCleared };
    });
  }

  /**
   * Deletes a table and all its rows.
   *
   * @param name - Table name
   * @returns The number of deleted rows
   * @throws {DataTableError} 404 when missing
   */
  deleteTable(name: string): { deleted: number } {
    const deleted = this.#db.transaction(() => {
      const table = this.requireTable(name);
      const n = this.#deleteWhere(eq(dataTableRows.tableId, table.id));
      this.#db.delete(dataTables).where(eq(dataTables.id, table.id)).run();
      return n;
    });
    this.#onChange({ table: name, deleted: true });
    return { deleted };
  }

  // -------------------------------------------------------------------------
  // Rows: reads
  // -------------------------------------------------------------------------

  /**
   * Queries rows with filters, sorting, and paging.
   *
   * @param name - Table name
   * @param query - Filters, sort, limit, offset
   * @returns The page of rows and the total match count
   * @throws {DataTableError} 400 for invalid filters, 404 when the table is missing
   */
  queryRows(name: string, query: RowQuery = {}): { rows: RowRecord[]; total: number } {
    const table = this.requireTable(name);
    const where = buildWhere(table.id, table.columns, query.filters);
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), MAX_QUERY_LIMIT);
    const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
    const total = this.#db.select({ n: count() }).from(dataTableRows).where(where).get()?.n ?? 0;
    const rows = this.#db
      .select()
      .from(dataTableRows)
      .where(where)
      .orderBy(buildOrderBy(table.columns, query.sort))
      .limit(limit)
      .offset(offset)
      .all();
    return { rows: rows.map((r) => this.#toRecord(r, table.columns)), total };
  }

  /**
   * Iterates over all matching rows in id order, in pages (for export).
   *
   * @param name - Table name
   * @param filters - Optional filters
   * @param sort - Optional sort
   * @returns A generator of rows
   * @throws {DataTableError} 400 for invalid filters, 404 when the table is missing
   */
  *iterateRows(name: string, filters?: Filter[], sort?: Sort): Generator<RowRecord> {
    let offset = 0;
    for (;;) {
      const { rows } = this.queryRows(name, { filters, sort, limit: MAX_QUERY_LIMIT, offset });
      yield* rows;
      if (rows.length < MAX_QUERY_LIMIT) return;
      offset += rows.length;
    }
  }

  // -------------------------------------------------------------------------
  // Rows: writes
  // -------------------------------------------------------------------------

  /**
   * Inserts rows. By default the batch is all-or-nothing; with `skipInvalid`
   * invalid rows are skipped and reported instead.
   *
   * @param name - Table name
   * @param inputs - Raw row objects
   * @param options - `skipInvalid`: skip failing rows; `replace`: delete all existing rows first
   * @returns Inserted ids and skipped rows
   * @throws {DataTableError} 400 when rows fail validation (strict mode), 404 when the table is missing
   */
  insertRows(
    name: string,
    inputs: readonly Record<string, unknown>[],
    options: { skipInvalid?: boolean; replace?: boolean } = {},
  ): InsertResult {
    const result = this.#db.transaction(() => {
      const table = this.requireTable(name);
      if (options.replace) this.#deleteWhere(eq(dataTableRows.tableId, table.id));
      const rowErrors: RowError[] = [];
      const pending: PendingWrite[] = [];
      inputs.forEach((input, index) => {
        const { row, errors } = coerceRow(table.columns, input);
        if (errors.length > 0) rowErrors.push({ index, errors });
        else pending.push({ index, data: row });
      });
      const accepted = this.#checkUnique(table, pending, rowErrors, options.skipInvalid === true);
      if (rowErrors.length > 0 && !options.skipInvalid) throw rowValidationError(rowErrors);
      const ids = this.#write(table, accepted);
      rowErrors.sort((a, b) => a.index - b.index);
      return {
        inserted: ids.length,
        ids,
        skipped: rowErrors.slice(0, MAX_REPORTED_ERRORS),
        skippedCount: rowErrors.length,
      };
    });
    if (result.inserted > 0 || options.replace) this.#onChange({ table: name });
    return result;
  }

  /**
   * Updates a single row by id.
   *
   * @param name - Table name
   * @param id - Row id
   * @param patch - Column values to change
   * @returns The updated row
   * @throws {DataTableError} 400 when invalid, 404 when the table or row is missing
   */
  updateRow(name: string, id: number, patch: Record<string, unknown>): RowRecord {
    const record = this.#db.transaction(() => {
      const table = this.requireTable(name);
      const existing = this.#db
        .select()
        .from(dataTableRows)
        .where(and(eq(dataTableRows.tableId, table.id), eq(dataTableRows.id, id)))
        .get();
      if (!existing) throw new DataTableError(404, `Row ${id} not found in table "${name}"`);
      const { row, errors } = coerceRow(table.columns, patch, { partial: true });
      if (errors.length > 0) throw rowValidationError([{ index: 0, errors }]);
      const data = { ...this.#parseData(existing.data), ...row };
      const rowErrors: RowError[] = [];
      this.#checkUnique(table, [{ index: 0, id, data }], rowErrors, false);
      if (rowErrors.length > 0) throw rowValidationError(rowErrors);
      this.#write(table, [{ index: 0, id, data }]);
      const updated = this.#db.select().from(dataTableRows).where(eq(dataTableRows.id, id)).get();
      return this.#toRecord(updated!, table.columns);
    });
    this.#onChange({ table: name });
    return record;
  }

  /**
   * Applies the same patch to every row matching the filters.
   *
   * @param name - Table name
   * @param filters - AND-combined filters (empty = all rows)
   * @param patch - Column values to set
   * @returns The number of updated rows
   * @throws {DataTableError} 400 when invalid, 404 when the table is missing
   */
  updateRows(name: string, filters: readonly Filter[], patch: Record<string, unknown>): { updated: number } {
    const updated = this.#db.transaction(() => {
      const table = this.requireTable(name);
      const { row, errors } = coerceRow(table.columns, patch, { partial: true });
      if (errors.length > 0) throw rowValidationError([{ index: 0, errors }], "validation (patch)");
      if (Object.keys(row).length === 0) return 0;
      const matches = this.#db
        .select({ id: dataTableRows.id, data: dataTableRows.data })
        .from(dataTableRows)
        .where(buildWhere(table.id, table.columns, filters))
        .all();
      const pending = matches.map((m, index) => ({ index, id: m.id, data: { ...this.#parseData(m.data), ...row } }));
      const rowErrors: RowError[] = [];
      this.#checkUnique(table, pending, rowErrors, false);
      if (rowErrors.length > 0) throw rowValidationError(rowErrors);
      this.#write(table, pending);
      return pending.length;
    });
    if (updated > 0) this.#onChange({ table: name });
    return { updated };
  }

  /**
   * Inserts or updates rows identified by a key column. Existing rows are
   * patched with the provided values; new rows are inserted with defaults.
   * The batch is all-or-nothing.
   *
   * @param name - Table name
   * @param inputs - Raw row objects (each must contain the key column)
   * @param keyColumn - Key column (defaults to the table's key column)
   * @returns Insert/update counts and affected ids
   * @throws {DataTableError} 400 when invalid or no key column, 404 when the table is missing
   */
  upsertRows(name: string, inputs: readonly Record<string, unknown>[], keyColumn?: string): UpsertResult {
    const result = this.#db.transaction(() => {
      const table = this.requireTable(name);
      const key = keyColumn || table.keyColumn;
      if (!key) {
        throw new DataTableError(400, `Table "${name}" has no key column; specify the column to match rows on`);
      }
      const keyCol = table.columns.find((c) => c.key === key);
      if (!keyCol) throw new DataTableError(400, `Unknown key column "${key}"`);

      const existingByKey = new Map<string, number>();
      for (const r of this.#columnValues(table.id, key)) existingByKey.set(valueKey(r.v), r.id);

      const rowErrors: RowError[] = [];
      const pendingByKey = new Map<string, PendingWrite>();
      const order: PendingWrite[] = [];
      inputs.forEach((input, index) => {
        const keyResult = coerceValue(keyCol, input[key]);
        if (!keyResult.ok || keyResult.value === null) {
          rowErrors.push({ index, errors: [keyResult.ok ? `${key}: key value is required` : keyResult.error] });
          return;
        }
        const k = valueKey(keyResult.value);
        const pending = pendingByKey.get(k);
        const existingId = existingByKey.get(k);
        const isUpdate = pending !== undefined || existingId !== undefined;
        const { row, errors } = coerceRow(table.columns, input, { partial: isUpdate });
        if (errors.length > 0) {
          rowErrors.push({ index, errors });
          return;
        }
        if (pending) {
          Object.assign(pending.data, row);
          order.push(pending);
          return;
        }
        const data = existingId !== undefined ? { ...this.#loadData(existingId), ...row } : row;
        const write: PendingWrite = { index, id: existingId, data };
        pendingByKey.set(k, write);
        order.push(write);
      });
      if (rowErrors.length > 0) throw rowValidationError(rowErrors);

      const writes = [...pendingByKey.values()];
      this.#checkUnique(table, writes, rowErrors, false);
      if (rowErrors.length > 0) throw rowValidationError(rowErrors);
      const inserted = writes.filter((w) => w.id === undefined).length;
      this.#write(table, writes);
      return { inserted, updated: writes.length - inserted, ids: order.map((w) => w.id as number) };
    });
    if (result.ids.length > 0) this.#onChange({ table: name });
    return result;
  }

  /**
   * Deletes rows by id and/or filter (both given = intersection).
   *
   * @param name - Table name
   * @param target - Row ids and/or filters; at least one must be non-empty
   * @returns The number of deleted rows
   * @throws {DataTableError} 400 when no target is given, 404 when the table is missing
   */
  deleteRows(name: string, target: { ids?: number[]; filters?: Filter[] }): { deleted: number } {
    const table = this.requireTable(name);
    const hasIds = target.ids !== undefined;
    if (!hasIds && (!target.filters || target.filters.length === 0)) {
      throw new DataTableError(400, "Specify row ids or at least one filter (use truncate to delete all rows)");
    }
    if (hasIds && target.ids?.length === 0) return { deleted: 0 };
    const conditions: SQL[] = [buildWhere(table.id, table.columns, target.filters)];
    if (target.ids) conditions.push(inArray(dataTableRows.id, target.ids));
    const deleted = this.#deleteWhere(and(...conditions)!);
    if (deleted > 0) this.#onChange({ table: name });
    return { deleted };
  }

  /**
   * Deletes all rows of a table.
   *
   * @param name - Table name
   * @returns The number of deleted rows
   * @throws {DataTableError} 404 when the table is missing
   */
  truncate(name: string): { deleted: number } {
    const table = this.requireTable(name);
    const deleted = this.#deleteWhere(eq(dataTableRows.tableId, table.id));
    this.#onChange({ table: name });
    return { deleted };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Deletes rows matching a condition and returns how many were removed. */
  #deleteWhere(where: SQL): number {
    return this.#db.delete(dataTableRows).where(where).returning({ id: dataTableRows.id }).all().length;
  }

  /** Reads the non-null values of one column for all rows of a table. */
  #columnValues(tableId: string, key: string): { id: number; v: unknown }[] {
    return this.#db.all<{ id: number; v: unknown }>(
      sql`SELECT ${dataTableRows.id} AS id, json_extract(${dataTableRows.data}, ${jsonPath(key)}) AS v
          FROM ${dataTableRows}
          WHERE ${dataTableRows.tableId} = ${tableId} AND v IS NOT NULL`,
    );
  }

  /** Loads and parses one row's data. */
  #loadData(id: number): Record<string, unknown> {
    const row = this.#db.select({ data: dataTableRows.data }).from(dataTableRows).where(eq(dataTableRows.id, id)).get();
    return row ? this.#parseData(row.data) : {};
  }

  /**
   * Checks `unique` columns for pending writes against existing rows (other
   * than those being rewritten) and against each other.
   *
   * @returns The writes that passed; failures are appended to `rowErrors`
   */
  #checkUnique(table: TableDef, pending: PendingWrite[], rowErrors: RowError[], skip: boolean): PendingWrite[] {
    const uniqueCols = table.columns.filter((c) => c.unique);
    if (uniqueCols.length === 0) return pending;
    const rewritten = new Set(pending.flatMap((p) => (p.id === undefined ? [] : [p.id])));
    const taken = new Map<string, Set<string>>();
    for (const col of uniqueCols) {
      const values = new Set<string>();
      for (const r of this.#columnValues(table.id, col.key)) if (!rewritten.has(r.id)) values.add(valueKey(r.v));
      taken.set(col.key, values);
    }
    const accepted: PendingWrite[] = [];
    for (const write of pending) {
      const errors: string[] = [];
      for (const col of uniqueCols) {
        const v = write.data[col.key];
        if (v === null || v === undefined) continue;
        if (taken.get(col.key)?.has(valueKey(v))) errors.push(`${col.key}: value ${JSON.stringify(v)} already exists`);
      }
      if (errors.length > 0) {
        rowErrors.push({ index: write.index, errors });
        if (skip) continue;
      }
      for (const col of uniqueCols) {
        const v = write.data[col.key];
        if (v !== null && v !== undefined) taken.get(col.key)?.add(valueKey(v));
      }
      accepted.push(write);
    }
    return accepted;
  }

  /**
   * Persists pending writes (inserts and updates) and touches the table.
   *
   * @returns Ids of the written rows in pending order
   */
  #write(table: TableDef, pending: PendingWrite[]): number[] {
    const now = Date.now();
    const ids: number[] = [];
    const inserts = pending.filter((p) => p.id === undefined);
    const insertSet = new Set(inserts);
    for (let i = 0; i < inserts.length; i += INSERT_CHUNK) {
      const chunk = inserts.slice(i, i + INSERT_CHUNK);
      const returned = this.#db
        .insert(dataTableRows)
        .values(
          chunk.map((p) => ({
            tableId: table.id,
            data: this.#serialize(table.columns, p.data),
            createdAt: now,
            updatedAt: now,
          })),
        )
        .returning({ id: dataTableRows.id })
        .all();
      chunk.forEach((p, j) => {
        p.id = returned[j]?.id;
      });
    }
    for (const p of pending) {
      if (insertSet.has(p)) {
        ids.push(p.id as number);
        continue;
      }
      this.#db
        .update(dataTableRows)
        .set({ data: this.#serialize(table.columns, p.data), updatedAt: now })
        .where(eq(dataTableRows.id, p.id as number))
        .run();
      ids.push(p.id as number);
    }
    if (pending.length > 0) {
      this.#db.update(dataTables).set({ updatedAt: now }).where(eq(dataTables.id, table.id)).run();
    }
    return ids;
  }

  /**
   * Maps each new column key to the old key it takes its values from.
   *
   * @throws {DataTableError} 400 for inconsistent renames
   */
  #resolveSources(
    oldColumns: readonly ColumnDef[],
    newColumns: readonly ColumnDef[],
    renames: Record<string, string>,
  ): Map<string, string> {
    const oldKeys = new Set(oldColumns.map((c) => c.key));
    const newKeys = new Set(newColumns.map((c) => c.key));
    const inverse = new Map<string, string>();
    for (const [from, to] of Object.entries(renames)) {
      if (from === to) continue;
      if (!oldKeys.has(from)) throw new DataTableError(400, `Cannot rename unknown column "${from}"`);
      if (!newKeys.has(to)) throw new DataTableError(400, `Rename target "${to}" is not in the new column list`);
      if (inverse.has(to)) throw new DataTableError(400, `Two columns are renamed to "${to}"`);
      inverse.set(to, from);
    }
    const sources = new Map<string, string>();
    for (const col of newColumns) {
      const renamedFrom = inverse.get(col.key);
      if (renamedFrom) sources.set(col.key, renamedFrom);
      else if (oldKeys.has(col.key) && !(col.key in renames && renames[col.key] !== col.key)) {
        sources.set(col.key, col.key);
      }
    }
    return sources;
  }

  /**
   * Rewrites every row of a table for a new column list.
   *
   * @throws {DataTableError} 409 on conversion conflicts (without `force`) or duplicate unique values
   */
  #migrateRows(
    table: TableDef,
    columns: readonly ColumnDef[],
    sourceOf: Map<string, string>,
    force: boolean,
  ): { rowsRewritten: number; valuesCleared: number } {
    const oldByKey = new Map(table.columns.map((c) => [c.key, c]));
    const rows = this.#db
      .select({ id: dataTableRows.id, data: dataTableRows.data })
      .from(dataTableRows)
      .where(eq(dataTableRows.tableId, table.id))
      .all();
    const conflicts: RowError[] = [];
    let valuesCleared = 0;
    const writes: PendingWrite[] = [];

    rows.forEach((r, index) => {
      const oldData = this.#parseData(r.data);
      const data: Record<string, unknown> = {};
      const errors: string[] = [];
      for (const col of columns) {
        const source = sourceOf.get(col.key);
        let value: unknown = source ? (oldData[source] ?? null) : (col.default ?? null);
        const oldCol = source ? oldByKey.get(source) : undefined;
        if (value !== null && oldCol && oldCol.type !== col.type) {
          const converted = coerceToType(col.type, value);
          if (converted.ok) value = converted.value;
          else {
            errors.push(`${col.key}: ${converted.error}`);
            value = null;
            valuesCleared++;
          }
        }
        if (value === null && col.required) errors.push(`${col.key}: value is required`);
        data[col.key] = value;
      }
      if (errors.length > 0) conflicts.push({ index: r.id, errors });
      if (JSON.stringify(data) !== JSON.stringify(oldData)) writes.push({ index, id: r.id, data });
    });

    if (conflicts.length > 0 && !force) {
      throw new DataTableError(
        409,
        `${conflicts.length} row(s) do not fit the new schema; save with "force" to clear the failing values`,
        { rows: conflicts.slice(0, MAX_REPORTED_ERRORS), count: conflicts.length },
      );
    }

    // Uniqueness is checked against the full new dataset.
    const writesById = new Map(writes.map((w) => [w.id, w]));
    const allRows: PendingWrite[] = rows.map(
      (r, index) => writesById.get(r.id) ?? { index, id: r.id, data: this.#parseData(r.data) },
    );
    const dupErrors: RowError[] = [];
    this.#checkUnique({ ...table, columns: [...columns] }, allRows, dupErrors, false);
    if (dupErrors.length > 0) {
      throw new DataTableError(409, `Column values are not unique: ${dupErrors[0]?.errors.join("; ")}`, {
        rows: dupErrors.slice(0, MAX_REPORTED_ERRORS).map((e) => ({ ...e, index: rows[e.index]?.id ?? e.index })),
        count: dupErrors.length,
      });
    }

    const now = Date.now();
    for (const w of writes) {
      this.#db
        .update(dataTableRows)
        .set({ data: this.#serialize(columns, w.data), updatedAt: now })
        .where(eq(dataTableRows.id, w.id as number))
        .run();
    }
    return { rowsRewritten: writes.length, valuesCleared: force ? valuesCleared : 0 };
  }

  /** Serializes row data in column order (unknown keys dropped). */
  #serialize(columns: readonly ColumnDef[], data: Record<string, unknown>): string {
    const ordered: Record<string, unknown> = {};
    for (const col of columns) ordered[col.key] = data[col.key] ?? null;
    return JSON.stringify(ordered);
  }

  /** Parses stored row JSON, tolerating corruption. */
  #parseData(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** Converts a stored row to the public record shape. */
  #toRecord(row: typeof dataTableRows.$inferSelect, columns: readonly ColumnDef[]): RowRecord {
    const data = this.#parseData(row.data);
    const record: RowRecord = { _id: row.id, _createdAt: row.createdAt, _updatedAt: row.updatedAt };
    for (const col of columns) record[col.key] = data[col.key] ?? null;
    return record;
  }

  /** Converts a stored table row to a {@link TableDef}. */
  #toTableDef(row: typeof dataTables.$inferSelect): TableDef {
    let columns: ColumnDef[] = [];
    try {
      columns = JSON.parse(row.columns) as ColumnDef[];
    } catch {
      columns = [];
    }
    const def: TableDef = {
      id: row.id,
      name: row.name,
      label: row.label,
      columns,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (row.description) def.description = row.description;
    if (row.keyColumn) def.keyColumn = row.keyColumn;
    if (row.createdByUserId) def.createdByUserId = row.createdByUserId;
    return def;
  }
}
