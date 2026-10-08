/**
 * Workflow step types for data tables: insert, update, delete, truncate,
 * upsert, and query.
 *
 * Steps call the store directly (they run with the workflow's authority, like
 * every other step type). String config fields support `{{template}}`
 * expressions; resolved values are coerced to the column types.
 *
 * @module
 */

import { extractJson, formatValidationErrors } from "@ext/sdk";
import type { StepExecutionContext, StepInputValidation, StepTypeHandler } from "@ext/types";
import { type TObject, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { DataTableStore } from "./store";
import {
  type ColumnDef,
  FILTER_OP_LABELS,
  FILTER_OPS,
  type Filter,
  type FilterOp,
  META_COLUMNS,
  VALUELESS_OPS,
} from "./types";

/** Dynamic item provider name for the table dropdown. */
export const TABLE_NAMES_PROVIDER = "datatable-names";

/** Maximum rows a query step returns. */
const MAX_STEP_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Config schema pieces
// ---------------------------------------------------------------------------

const TableField = Type.String({
  title: "Table",
  description: "Name of the data table. Supports {{template}} expressions.",
  minLength: 1,
  dynamicItems: TABLE_NAMES_PROVIDER,
});

const WhereField = Type.Array(
  Type.Object(
    {
      column: Type.String({ title: "Column", minLength: 1 }),
      op: Type.Union(
        FILTER_OPS.map((op) => Type.Literal(op)),
        {
          title: "Operator",
          default: "eq",
          description: FILTER_OPS.map((op) => `${op}: ${FILTER_OP_LABELS[op]}`).join(", "),
        },
      ),
      value: Type.Optional(
        Type.String({
          title: "Value",
          description: "Comparison value; comma-separated for 'in'. Supports {{template}} expressions.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
  {
    title: "Where",
    description: "Conditions (all must match). Columns may also be _id, _createdAt, _updatedAt.",
  },
);

const ValuesField = Type.Record(Type.String(), Type.String(), {
  title: "Values",
  description: "Column → value. Values support {{template}} expressions and are converted to the column type.",
});

const RowsField = Type.String({
  title: "Rows (JSON)",
  description:
    "Template resolving to a JSON object or array of objects, e.g. {{ steps.fetch.result.items }}. Used instead of Values for multiple rows.",
  multiline: true,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strips engine fields and validates a step config. */
function parseConfig<T>(schema: TObject, stepDef: Record<string, unknown>, type: string): T {
  const { slug: _slug, type: _type, outputSchema: _os, ...config } = stepDef;
  if (!Value.Check(schema, config)) {
    throw new Error(`Invalid ${type} step configuration: ${formatValidationErrors(schema, config)}`);
  }
  return config as T;
}

/** Resolves a template and logs its warnings. */
async function resolve(ctx: StepExecutionContext, template: string, field: string): Promise<string> {
  const { resolved, warnings } = await ctx.resolveTemplate(template);
  for (const w of warnings) await ctx.jobLog(`Warning (${field}): ${w}`);
  return resolved;
}

/** Resolves the table name template. */
async function resolveTable(ctx: StepExecutionContext, table: string): Promise<string> {
  const name = (await resolve(ctx, table, "table")).trim();
  if (!name) throw new Error("Resolved table name is empty");
  return name;
}

/** Resolves `where` conditions. */
async function resolveWhere(
  ctx: StepExecutionContext,
  where: { column: string; op: FilterOp; value?: string }[] | undefined,
): Promise<Filter[]> {
  const filters: Filter[] = [];
  for (const w of where ?? []) {
    const filter: Filter = { column: w.column.trim(), op: w.op };
    if (!VALUELESS_OPS.includes(w.op)) filter.value = await resolve(ctx, w.value ?? "", `where.${w.column}`);
    filters.push(filter);
  }
  return filters;
}

/** Resolves a `values` map. */
async function resolveValues(
  ctx: StepExecutionContext,
  values: Record<string, string> | undefined,
): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = {};
  for (const [key, template] of Object.entries(values ?? {})) row[key.trim()] = await resolve(ctx, template, key);
  return row;
}

/**
 * Parses a resolved `rows` string into row objects.
 *
 * @throws {Error} when the value is not a JSON object or array of objects
 */
export function parseRows(resolved: string): Record<string, unknown>[] {
  const trimmed = resolved.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    try {
      parsed = JSON.parse(extractJson(trimmed));
    } catch {
      throw new Error("Rows must be a JSON object or an array of objects");
    }
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (!list.every((r) => r !== null && typeof r === "object" && !Array.isArray(r))) {
    throw new Error("Rows must be a JSON object or an array of objects");
  }
  return list as Record<string, unknown>[];
}

/** Collects the rows to write from `rows` and/or `values`. */
async function resolveInputRows(
  ctx: StepExecutionContext,
  config: { rows?: string; values?: Record<string, string> },
): Promise<Record<string, unknown>[]> {
  const rows = config.rows !== undefined ? parseRows(await resolve(ctx, config.rows, "rows")) : [];
  if (config.values && Object.keys(config.values).length > 0) rows.push(await resolveValues(ctx, config.values));
  return rows;
}

/** Whether a configured value contains a template. */
const isTemplated = (v: unknown): boolean => typeof v === "string" && v.includes("{{");

/**
 * Statically checks a step's table and column references (templated values
 * are skipped), so misconfigurations surface before the step runs.
 */
function validateReferences(store: DataTableStore, stepDef: Record<string, unknown>): StepInputValidation {
  const table = stepDef.table;
  if (typeof table !== "string" || !table.trim() || isTemplated(table)) return { valid: true };
  const def = store.getTable(table.trim());
  if (!def) {
    const known = store.tableNames();
    return {
      valid: false,
      diagnostics: [`Data table "${table}" does not exist. Available tables: ${known.join(", ") || "(none)"}.`],
    };
  }
  const keys = new Set([...def.columns.map((c) => c.key), ...META_COLUMNS]);
  const diagnostics: string[] = [];
  const refs = [
    ...(Array.isArray(stepDef.where) ? (stepDef.where as { column?: unknown }[]).map((w) => w.column) : []),
    ...Object.keys((stepDef.values as Record<string, unknown> | undefined) ?? {}),
    ...Object.keys((stepDef.set as Record<string, unknown> | undefined) ?? {}),
    stepDef.orderBy,
    stepDef.keyColumn,
  ];
  for (const ref of refs) {
    if (typeof ref === "string" && ref.trim() && !keys.has(ref.trim())) {
      diagnostics.push(
        `Data table "${table}" has no column "${ref}". Columns: ${def.columns.map((c) => c.key).join(", ")}.`,
      );
    }
  }
  return diagnostics.length > 0 ? { valid: false, diagnostics } : { valid: true };
}

/** Maps a column to a TypeBox schema for output schemas. */
function columnSchema(column: ColumnDef): TSchema {
  const description = column.label;
  switch (column.type) {
    case "number":
      return Type.Number({ description });
    case "integer":
      return Type.Integer({ description });
    case "boolean":
      return Type.Boolean({ description });
    case "date":
      return Type.String({ description, format: "date" });
    case "datetime":
      return Type.String({ description, format: "date-time" });
    case "json":
      return Type.Unknown({ description });
    default:
      return Type.String({ description });
  }
}

/** Builds the row schema for a statically configured table. */
function rowSchemaFor(store: DataTableStore, stepDef: Record<string, unknown>): TSchema {
  const meta = {
    _id: Type.Integer({ description: "Row id" }),
    _createdAt: Type.Integer({ description: "Creation time (epoch ms)" }),
    _updatedAt: Type.Integer({ description: "Last update (epoch ms)" }),
  };
  const table =
    typeof stepDef.table === "string" && !isTemplated(stepDef.table) ? store.getTable(stepDef.table.trim()) : undefined;
  if (!table) return Type.Object(meta, { additionalProperties: true });
  return Type.Object({ ...meta, ...Object.fromEntries(table.columns.map((c) => [c.key, columnSchema(c)])) });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const InsertConfig = Type.Object(
  { table: TableField, values: Type.Optional(ValuesField), rows: Type.Optional(RowsField) },
  { additionalProperties: false },
);

const UpdateConfig = Type.Object(
  {
    table: TableField,
    where: Type.Optional(WhereField),
    set: Type.Record(Type.String(), Type.String(), {
      title: "Set",
      description: "Column → new value. Supports {{template}} expressions.",
    }),
  },
  { additionalProperties: false },
);

const DeleteConfig = Type.Object(
  {
    table: TableField,
    where: Type.Optional(WhereField),
    all: Type.Optional(
      Type.Boolean({ title: "Delete all rows", description: "Required to delete without conditions.", default: false }),
    ),
  },
  { additionalProperties: false },
);

const TruncateConfig = Type.Object({ table: TableField }, { additionalProperties: false });

const UpsertConfig = Type.Object(
  {
    table: TableField,
    keyColumn: Type.Optional(
      Type.String({
        title: "Key column",
        description: "Column that identifies a row. Defaults to the table's key column.",
      }),
    ),
    values: Type.Optional(ValuesField),
    rows: Type.Optional(RowsField),
  },
  { additionalProperties: false },
);

const QueryConfig = Type.Object(
  {
    table: TableField,
    where: Type.Optional(WhereField),
    orderBy: Type.Optional(Type.String({ title: "Order by", description: "Column to sort by (default: row id)." })),
    desc: Type.Optional(Type.Boolean({ title: "Descending", default: false })),
    limit: Type.Optional(
      Type.Integer({
        title: "Limit",
        description: `Maximum rows (1-${MAX_STEP_LIMIT}).`,
        minimum: 1,
        maximum: MAX_STEP_LIMIT,
        default: 100,
      }),
    ),
  },
  { additionalProperties: false },
);

type WhereConfig = { column: string; op: FilterOp; value?: string }[];

/**
 * Creates all data table step handlers.
 *
 * @param store - The data table store
 * @returns Handlers keyed by step type
 */
export function createStepHandlers(store: DataTableStore): Record<string, StepTypeHandler> {
  const validateInput = (_output: unknown, stepDef: Record<string, unknown>) => validateReferences(store, stepDef);

  return {
    "datatable-insert": {
      schema: InsertConfig,
      label: "Insert Rows",
      icon: "TableIcon",
      validateInput,
      outputSchema: Type.Object({
        inserted: Type.Integer({ description: "Number of inserted rows" }),
        ids: Type.Array(Type.Integer(), { description: "Ids of the inserted rows" }),
      }),
      async execute(stepDef, ctx) {
        const config = parseConfig<{ table: string; values?: Record<string, string>; rows?: string }>(
          InsertConfig,
          stepDef,
          "datatable-insert",
        );
        const table = await resolveTable(ctx, config.table);
        const rows = await resolveInputRows(ctx, config);
        if (rows.length === 0) {
          await ctx.jobLog("No rows to insert");
          return { inserted: 0, ids: [] };
        }
        const result = store.insertRows(table, rows);
        await ctx.jobLog(`Inserted ${result.inserted} row(s) into "${table}"`);
        return { inserted: result.inserted, ids: result.ids };
      },
    },

    "datatable-update": {
      schema: UpdateConfig,
      label: "Update Rows",
      icon: "TableIcon",
      validateInput,
      outputSchema: Type.Object({ updated: Type.Integer({ description: "Number of updated rows" }) }),
      async execute(stepDef, ctx) {
        const config = parseConfig<{ table: string; where?: WhereConfig; set: Record<string, string> }>(
          UpdateConfig,
          stepDef,
          "datatable-update",
        );
        const table = await resolveTable(ctx, config.table);
        const result = store.updateRows(
          table,
          await resolveWhere(ctx, config.where),
          await resolveValues(ctx, config.set),
        );
        await ctx.jobLog(`Updated ${result.updated} row(s) in "${table}"`);
        return result;
      },
    },

    "datatable-delete": {
      schema: DeleteConfig,
      label: "Delete Rows",
      icon: "TableIcon",
      validateInput,
      outputSchema: Type.Object({ deleted: Type.Integer({ description: "Number of deleted rows" }) }),
      async execute(stepDef, ctx) {
        const config = parseConfig<{ table: string; where?: WhereConfig; all?: boolean }>(
          DeleteConfig,
          stepDef,
          "datatable-delete",
        );
        const table = await resolveTable(ctx, config.table);
        const filters = await resolveWhere(ctx, config.where);
        let result: { deleted: number };
        if (filters.length === 0) {
          if (!config.all) throw new Error('datatable-delete: add a condition or enable "Delete all rows"');
          result = store.truncate(table);
        } else {
          result = store.deleteRows(table, { filters });
        }
        await ctx.jobLog(`Deleted ${result.deleted} row(s) from "${table}"`);
        return result;
      },
    },

    "datatable-truncate": {
      schema: TruncateConfig,
      label: "Truncate Table",
      icon: "TableIcon",
      validateInput,
      outputSchema: Type.Object({ deleted: Type.Integer({ description: "Number of deleted rows" }) }),
      async execute(stepDef, ctx) {
        const config = parseConfig<{ table: string }>(TruncateConfig, stepDef, "datatable-truncate");
        const table = await resolveTable(ctx, config.table);
        const result = store.truncate(table);
        await ctx.jobLog(`Truncated "${table}" (${result.deleted} row(s) deleted)`);
        return result;
      },
    },

    "datatable-upsert": {
      schema: UpsertConfig,
      label: "Upsert Rows",
      icon: "TableIcon",
      validateInput,
      outputSchema: Type.Object({
        inserted: Type.Integer({ description: "Number of inserted rows" }),
        updated: Type.Integer({ description: "Number of updated rows" }),
        ids: Type.Array(Type.Integer(), { description: "Ids of the affected rows" }),
      }),
      async execute(stepDef, ctx) {
        const config = parseConfig<{
          table: string;
          keyColumn?: string;
          values?: Record<string, string>;
          rows?: string;
        }>(UpsertConfig, stepDef, "datatable-upsert");
        const table = await resolveTable(ctx, config.table);
        const rows = await resolveInputRows(ctx, config);
        if (rows.length === 0) {
          await ctx.jobLog("No rows to upsert");
          return { inserted: 0, updated: 0, ids: [] };
        }
        const result = store.upsertRows(table, rows, config.keyColumn?.trim() || undefined);
        await ctx.jobLog(`Upserted into "${table}": ${result.inserted} inserted, ${result.updated} updated`);
        return result;
      },
    },

    "datatable-query": {
      schema: QueryConfig,
      label: "Query Table",
      icon: "TableIcon",
      validateInput,
      outputSchema: (stepDef) => {
        const row = rowSchemaFor(store, stepDef);
        return Type.Object({
          rows: Type.Array(row, { description: "Matching rows" }),
          count: Type.Integer({ description: "Number of returned rows" }),
          total: Type.Integer({ description: "Number of matching rows (ignoring the limit)" }),
          // Not a union with null, so the editor can complete `first.<column>` paths.
          first: { ...row, description: "First matching row (null when nothing matches)" },
        });
      },
      async execute(stepDef, ctx) {
        const config = parseConfig<{
          table: string;
          where?: WhereConfig;
          orderBy?: string;
          desc?: boolean;
          limit?: number;
        }>(QueryConfig, stepDef, "datatable-query");
        const table = await resolveTable(ctx, config.table);
        const { rows, total } = store.queryRows(table, {
          filters: await resolveWhere(ctx, config.where),
          sort: config.orderBy?.trim() ? { column: config.orderBy.trim(), desc: config.desc } : undefined,
          limit: config.limit ?? 100,
        });
        await ctx.jobLog(`Query on "${table}" returned ${rows.length} of ${total} matching row(s)`);
        return { rows, count: rows.length, total, first: rows[0] ?? null };
      },
    },
  };
}
