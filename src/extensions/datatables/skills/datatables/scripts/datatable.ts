/**
 * Registers the `datatable` shell command for reading and writing data tables
 * via the extension's REST API (so the calling user's permissions apply).
 *
 * Subcommands: list, schema, query, insert, update, upsert, delete, truncate
 */

import { createCommand, formatFetchError, type ParsedArgs, registerProgram, type SkillScriptContext } from "@ext/sdk";
import type { CommandContext, ExecResult } from "just-bash";
import { decodeBytesToUtf8, EMPTY_BYTES } from "just-bash";
import {
  FILTER_OPS,
  type Filter,
  type FilterOp,
  type RowRecord,
  type TableDef,
  type TableSummary,
} from "../../../types";

/** Maximum displayed cell width in table output. */
const MAX_CELL = 40;

const WHERE_OPTION = {
  name: "where",
  short: "w",
  multiple: true,
  description: `Condition "column:op:value" or "column=value" (ops: ${FILTER_OPS.join(", ")})`,
};

const DATA_OPTIONS = [
  { name: "file", short: "f", description: "Read the JSON rows from a file in the work directory" },
] as const;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parses a `--where` expression.
 *
 * @param expr - `column:op:value`, `column:op` (isNull/notNull), or `column=value`
 * @returns The filter
 * @throws {Error} when the expression is malformed
 */
export function parseWhere(expr: string): Filter {
  const parts = expr.split(":");
  if (parts.length >= 2 && (FILTER_OPS as readonly string[]).includes(parts[1] ?? "")) {
    return { column: (parts[0] ?? "").trim(), op: parts[1] as FilterOp, value: parts.slice(2).join(":") };
  }
  const eq = expr.indexOf("=");
  if (eq > 0) return { column: expr.slice(0, eq).trim(), op: "eq", value: expr.slice(eq + 1) };
  throw new Error(`Invalid condition "${expr}". Use column:op:value or column=value.`);
}

/**
 * Parses `--set column=value` assignments.
 *
 * @param assignments - Raw assignments
 * @returns The values object
 * @throws {Error} when an assignment has no `=`
 */
export function parseAssignments(assignments: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const a of assignments) {
    const eq = a.indexOf("=");
    if (eq <= 0) throw new Error(`Invalid assignment "${a}". Use column=value.`);
    values[a.slice(0, eq).trim()] = a.slice(eq + 1);
  }
  return values;
}

/** Reads JSON rows from the positional argument, `--file`, or stdin. */
async function readRows(ctx: CommandContext, args: ParsedArgs): Promise<Record<string, unknown>[]> {
  let text = args.get("json");
  const file = args.option("file");
  if (file) text = await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, file));
  else if (!text || text === "-") {
    const hasStdin = ctx.stdin !== EMPTY_BYTES && (ctx.stdin as unknown) !== "";
    if (!hasStdin) throw new Error("No rows given. Pass JSON as an argument, with --file, or via stdin.");
    text = decodeBytesToUtf8(ctx.stdin);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Rows must be valid JSON (an object or an array of objects)");
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (!rows.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
    throw new Error("Rows must be an object or an array of objects");
  }
  return rows as Record<string, unknown>[];
}

/** Formats a cell for text output. */
function cell(value: unknown): string {
  const s =
    value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  const flat = s.replace(/\s+/g, " ");
  return flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 1)}…` : flat;
}

/**
 * Renders rows as an aligned text table.
 *
 * @param columns - Column keys (in order)
 * @param rows - Rows
 * @returns The table text
 */
export function renderTable(columns: string[], rows: Record<string, unknown>[]): string {
  const data = rows.map((r) => columns.map((c) => cell(r[c])));
  const widths = columns.map((c, i) => Math.max(c.length, ...data.map((r) => r[i]?.length ?? 0)));
  const line = (cells: string[]) =>
    cells
      .map((v, i) => v.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(columns), line(widths.map((w) => "-".repeat(w))), ...data.map(line)].join("\n");
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * Builds the `datatable` command handler.
 *
 * @param scriptCtx - Skill script context providing the extension base URL and authenticated fetch
 * @returns A command handler suitable for `registerProgram()`
 */
export function buildDatatableCommand(scriptCtx: SkillScriptContext) {
  /** Calls the API and returns the JSON body, throwing on HTTP errors. */
  async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}${path}`, {
      method: init?.method ?? "GET",
      headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    if (!resp.ok) {
      const details = data.details as { rows?: { index: number; errors: string[] }[] } | undefined;
      const rowLines = (details?.rows ?? []).slice(0, 10).map((r) => `  row ${r.index + 1}: ${r.errors.join("; ")}`);
      throw new Error([`${data.error ?? `HTTP ${resp.status}`}`, ...rowLines].join("\n"));
    }
    return data as T;
  }

  /** Wraps a handler with uniform error output. */
  const run =
    (fn: (ctx: CommandContext, args: ParsedArgs) => Promise<string>) =>
    async (ctx: CommandContext, args: ParsedArgs): Promise<ExecResult> => {
      try {
        return { exitCode: 0, stdout: `${await fn(ctx, args)}\n`, stderr: "" };
      } catch (err) {
        const msg = err instanceof TypeError ? formatFetchError(err) : `Error: ${(err as Error).message}`;
        return { exitCode: 1, stdout: "", stderr: msg };
      }
    };

  const tablePath = (args: ParsedArgs) => `/tables/${encodeURIComponent(args.get("table"))}`;
  const whereOf = (args: ParsedArgs) => args.options("where").map(parseWhere);

  return createCommand({
    name: "datatable",
    description: "Read and write data tables (structured tables managed in the Data Tables page).",
    subcommands: [
      {
        name: "list",
        description: "List all tables with row counts",
        handler: run(async () => {
          const { tables } = await api<{ tables: TableSummary[] }>("/tables");
          if (tables.length === 0) return "No data tables defined.";
          return renderTable(
            ["name", "label", "rows", "columns"],
            tables.map((t) => ({ name: t.name, label: t.label, rows: t.rowCount, columns: t.columns.length })),
          );
        }),
      },
      {
        name: "schema",
        description: "Show a table's columns",
        args: [{ name: "table", description: "Table name" }],
        handler: run(async (_ctx, args) => {
          const { table } = await api<{ table: TableDef & { rowCount: number } }>(tablePath(args));
          const head = [`${table.label} (${table.name}) - ${table.rowCount} rows`];
          if (table.description) head.push(table.description);
          if (table.keyColumn) head.push(`Key column: ${table.keyColumn}`);
          const cols = table.columns.map((c) => ({
            key: c.key,
            label: c.label,
            type: c.type,
            flags: [c.required ? "required" : "", c.unique ? "unique" : ""].filter(Boolean).join(","),
            default: c.default ?? "",
          }));
          return `${head.join("\n")}\n\n${renderTable(["key", "label", "type", "flags", "default"], cols)}`;
        }),
      },
      {
        name: "query",
        description: "Query rows",
        args: [{ name: "table", description: "Table name" }],
        options: [
          WHERE_OPTION,
          { name: "sort", short: "s", description: "Column to sort by" },
          { name: "desc", boolean: true, description: "Sort descending" },
          { name: "limit", short: "n", defaultValue: "50", description: "Maximum rows (1-1000, default 50)" },
          { name: "offset", defaultValue: "0", description: "Rows to skip" },
          { name: "json", boolean: true, description: "Output JSON instead of a text table" },
        ],
        handler: run(async (_ctx, args) => {
          const params = new URLSearchParams();
          const where = whereOf(args);
          if (where.length > 0) params.set("filter", JSON.stringify(where));
          if (args.option("sort")) params.set("sort", args.option("sort"));
          if (args.flag("desc")) params.set("desc", "true");
          params.set("limit", args.option("limit") || "50");
          params.set("offset", args.option("offset") || "0");
          const [{ table }, result] = await Promise.all([
            api<{ table: TableDef }>(tablePath(args)),
            api<{ rows: RowRecord[]; total: number }>(`${tablePath(args)}/rows?${params}`),
          ]);
          if (args.flag("json")) return JSON.stringify(result, null, 2);
          if (result.rows.length === 0) return `No matching rows (total ${result.total}).`;
          const text = renderTable(["_id", ...table.columns.map((c) => c.key)], result.rows);
          return `${text}\n\n${result.rows.length} of ${result.total} matching row(s)`;
        }),
      },
      {
        name: "insert",
        description: "Insert rows from JSON (object or array of objects)",
        args: [
          { name: "table", description: "Table name" },
          { name: "json", required: false, description: "JSON rows, or '-' / omitted to read stdin" },
        ],
        options: [...DATA_OPTIONS],
        handler: run(async (ctx, args) => {
          const rows = await readRows(ctx, args);
          const result = await api<{ inserted: number; ids: number[] }>(`${tablePath(args)}/rows`, {
            method: "POST",
            body: { rows },
          });
          return `Inserted ${result.inserted} row(s) (ids: ${result.ids.join(", ")})`;
        }),
      },
      {
        name: "update",
        description: "Set column values on all rows matching the conditions",
        args: [{ name: "table", description: "Table name" }],
        options: [
          WHERE_OPTION,
          { name: "set", multiple: true, required: true, description: "Assignment column=value (repeatable)" },
          { name: "all", boolean: true, description: "Allow updating every row (no conditions)" },
        ],
        handler: run(async (_ctx, args) => {
          const filters = whereOf(args);
          if (filters.length === 0 && !args.flag("all")) {
            throw new Error("Add --where conditions, or --all to update every row");
          }
          const result = await api<{ updated: number }>(`${tablePath(args)}/rows/update`, {
            method: "POST",
            body: { filters, values: parseAssignments(args.options("set")) },
          });
          return `Updated ${result.updated} row(s)`;
        }),
      },
      {
        name: "upsert",
        description: "Insert or update rows matched on a key column",
        args: [
          { name: "table", description: "Table name" },
          { name: "json", required: false, description: "JSON rows, or '-' / omitted to read stdin" },
        ],
        options: [
          ...DATA_OPTIONS,
          { name: "key", short: "k", description: "Key column (defaults to the table's key)" },
        ],
        handler: run(async (ctx, args) => {
          const rows = await readRows(ctx, args);
          const result = await api<{ inserted: number; updated: number }>(`${tablePath(args)}/rows/upsert`, {
            method: "POST",
            body: { rows, keyColumn: args.option("key") || undefined },
          });
          return `Upserted: ${result.inserted} inserted, ${result.updated} updated`;
        }),
      },
      {
        name: "delete",
        description: "Delete rows matching the conditions",
        args: [{ name: "table", description: "Table name" }],
        options: [WHERE_OPTION, { name: "id", multiple: true, description: "Row id (repeatable)" }],
        handler: run(async (_ctx, args) => {
          const filters = whereOf(args);
          const ids = args.options("id").map((id) => Number.parseInt(id, 10));
          if (ids.some(Number.isNaN)) throw new Error("Row ids must be integers");
          if (filters.length === 0 && ids.length === 0) {
            throw new Error("Add --where conditions or --id (use truncate to delete all rows)");
          }
          const body: { filters?: Filter[]; ids?: number[] } = {};
          if (filters.length > 0) body.filters = filters;
          if (ids.length > 0) body.ids = ids;
          const result = await api<{ deleted: number }>(`${tablePath(args)}/rows/delete`, { method: "POST", body });
          return `Deleted ${result.deleted} row(s)`;
        }),
      },
      {
        name: "truncate",
        description: "Delete all rows of a table",
        args: [{ name: "table", description: "Table name" }],
        handler: run(async (_ctx, args) => {
          const result = await api<{ deleted: number }>(`${tablePath(args)}/truncate`, { method: "POST" });
          return `Deleted ${result.deleted} row(s)`;
        }),
      },
    ],
  });
}

/**
 * Registers the `datatable` shell command with the sandbox.
 *
 * @param skillName - The skill name this program belongs to
 * @param ctx - Skill script context providing the extension base URL and authenticated fetch
 */
export async function registerSkill(skillName: string, ctx: SkillScriptContext) {
  registerProgram("datatable", buildDatatableCommand(ctx), skillName);
}
