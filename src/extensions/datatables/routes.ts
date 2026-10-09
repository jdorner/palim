/**
 * HTTP routes for the Data Tables extension (mounted under `/ext/datatables/`).
 *
 * Reads are GET routes (open to every signed-in user); all writes require the
 * `datatables:write` permission via the central authorization table.
 *
 * @module
 */

import { formatValidationErrors } from "@ext/sdk";
import type { ExtensionContext, Logger } from "@ext/types";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "elysia";
import { DataTableError } from "./errors";
import { buildPreview, defaultMapping, exportTable, mapRows, parseFile, splitHeader } from "./importExport";
import type { DataTableStore } from "./store";
import { COLUMN_TYPES, FILTER_OPS, type Filter, IMPORT_MODES, type ImportResult, type Sort } from "./types";

/** Schema for a column definition in request bodies. */
const ColumnSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 64 }),
    label: Type.String({ maxLength: 200 }),
    type: Type.Union(COLUMN_TYPES.map((t) => Type.Literal(t))),
    required: Type.Optional(Type.Boolean()),
    unique: Type.Optional(Type.Boolean()),
    default: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

/** Schema for a filter condition. */
export const FilterSchema = Type.Object(
  {
    column: Type.String({ minLength: 1 }),
    op: Type.Union(FILTER_OPS.map((op) => Type.Literal(op))),
    value: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

const RowObjectSchema = Type.Record(Type.String(), Type.Unknown());

const CreateTableSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 64 }),
    label: Type.Optional(Type.String({ maxLength: 200 })),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    columns: Type.Array(ColumnSchema),
    keyColumn: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const UpdateTableSchema = Type.Object(
  {
    label: Type.Optional(Type.String({ maxLength: 200 })),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    columns: Type.Optional(Type.Array(ColumnSchema)),
    renames: Type.Optional(Type.Record(Type.String(), Type.String())),
    keyColumn: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    force: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const InsertSchema = Type.Object(
  { rows: Type.Array(RowObjectSchema, { maxItems: 10_000 }) },
  { additionalProperties: false },
);
const UpdateRowSchema = Type.Object({ values: RowObjectSchema }, { additionalProperties: false });
const UpdateRowsSchema = Type.Object(
  { filters: Type.Optional(Type.Array(FilterSchema)), values: RowObjectSchema },
  { additionalProperties: false },
);
const DeleteRowsSchema = Type.Object(
  { ids: Type.Optional(Type.Array(Type.Integer())), filters: Type.Optional(Type.Array(FilterSchema)) },
  { additionalProperties: false },
);
const UpsertSchema = Type.Object(
  { rows: Type.Array(RowObjectSchema, { maxItems: 10_000 }), keyColumn: Type.Optional(Type.String()) },
  { additionalProperties: false },
);

/** Options sent with an import commit (multipart field `options`, JSON). */
const ImportOptionsSchema = Type.Object(
  {
    mode: Type.Union(IMPORT_MODES.map((m) => Type.Literal(m))),
    table: Type.String({ minLength: 1 }),
    sheet: Type.Optional(Type.String()),
    headerRow: Type.Optional(Type.Boolean()),
    delimiter: Type.Optional(Type.String({ maxLength: 1 })),
    // create mode
    label: Type.Optional(Type.String({ maxLength: 200 })),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    columns: Type.Optional(Type.Array(ColumnSchema)),
    keyColumn: Type.Optional(Type.String()),
    /** `{ columnKey: headerIndex }`; defaults to matching headers by key/label. */
    mapping: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 0 }))),
  },
  { additionalProperties: false },
);

/** Import options. */
export type ImportOptions = Static<typeof ImportOptionsSchema>;

/**
 * Validates a request body against a schema.
 *
 * @throws {DataTableError} 400 when invalid
 */
function check<T extends TSchema>(schema: T, body: unknown): Static<T> {
  if (!Value.Check(schema, body)) {
    throw new DataTableError(400, `Invalid request: ${formatValidationErrors(schema, body)}`);
  }
  return body as Static<T>;
}

/**
 * Parses the `filter` query parameter (JSON array of filters).
 *
 * @throws {DataTableError} 400 when malformed
 */
export function parseFilterParam(raw: string | null): Filter[] | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DataTableError(400, "Invalid filter parameter: not JSON");
  }
  return check(Type.Array(FilterSchema), parsed);
}

/** Parses `sort` / `desc` query parameters. */
function parseSortParam(params: URLSearchParams): Sort | undefined {
  const column = params.get("sort");
  return column ? { column, desc: params.get("desc") === "true" } : undefined;
}

/** Parses an integer query parameter. */
function intParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new DataTableError(400, `Invalid ${name} parameter`);
  return n;
}

/** Extracts the uploaded file from a multipart body. */
async function uploadedFile(body: unknown): Promise<{ bytes: Uint8Array; filename: string }> {
  const file = (body as Record<string, unknown> | undefined)?.file;
  if (!(file instanceof Blob)) throw new DataTableError(400, 'Missing "file" upload');
  const filename = file instanceof File ? file.name : "upload";
  return { bytes: new Uint8Array(await file.arrayBuffer()), filename };
}

/** Reads a string multipart field. */
function formField(body: unknown, name: string): string | undefined {
  const v = (body as Record<string, unknown> | undefined)?.[name];
  return typeof v === "string" ? v : undefined;
}

/**
 * Runs a parsed import against the store.
 *
 * @param store - The data table store
 * @param bytes - File content
 * @param filename - File name
 * @param options - Validated import options
 * @param userId - Importing user (for created tables)
 * @returns The import result
 * @throws {DataTableError} for invalid files, options, or target tables
 */
export async function runImport(
  store: DataTableStore,
  bytes: Uint8Array,
  filename: string,
  options: ImportOptions,
  userId?: string,
): Promise<ImportResult> {
  const parsed = await parseFile(bytes, filename, { sheet: options.sheet, delimiter: options.delimiter });
  const { headers, data } = splitHeader(parsed.rows, options.headerRow !== false);

  if (options.mode === "create") {
    if (!options.columns) throw new DataTableError(400, "Columns are required to create a table");
    const mapping = options.mapping ?? Object.fromEntries(options.columns.map((c, i) => [c.key, i]));
    store.createTable(
      {
        name: options.table,
        label: options.label,
        description: options.description,
        columns: options.columns,
        keyColumn: options.keyColumn,
      },
      userId,
    );
    try {
      const result = store.insertRows(options.table, mapRows(data, mapping), { skipInvalid: true });
      return {
        table: options.table,
        inserted: result.inserted,
        skipped: result.skipped,
        skippedCount: result.skippedCount,
      };
    } catch (err) {
      store.deleteTable(options.table);
      throw err;
    }
  }

  const table = store.requireTable(options.table);
  const mapping = options.mapping ?? defaultMapping(headers, table.columns);
  if (Object.keys(mapping).length === 0) {
    throw new DataTableError(400, "No file column matches a table column; provide a column mapping");
  }
  for (const [key, index] of Object.entries(mapping)) {
    if (!table.columns.some((c) => c.key === key)) throw new DataTableError(400, `Unknown column "${key}" in mapping`);
    if (index >= headers.length) throw new DataTableError(400, `Mapping for "${key}" points past the last file column`);
  }
  const result = store.insertRows(options.table, mapRows(data, mapping), {
    skipInvalid: true,
    replace: options.mode === "replace",
  });
  return {
    table: options.table,
    inserted: result.inserted,
    skipped: result.skipped,
    skippedCount: result.skippedCount,
  };
}

/** Route handler signature. */
type Handler = (reqCtx: Context) => Response | Promise<Response>;

/**
 * Registers all Data Tables routes.
 *
 * @param ctx - Extension context
 * @param store - The data table store
 * @param getUserId - Resolves the requesting user's id
 */
export function registerRoutes(
  ctx: ExtensionContext,
  store: DataTableStore,
  getUserId: (request: Request) => string | undefined,
): void {
  const log: Logger = ctx.log;

  /** Wraps a handler with error mapping. */
  const wrap =
    (fn: Handler): Handler =>
    async (reqCtx) => {
      try {
        return await fn(reqCtx);
      } catch (err) {
        if (err instanceof DataTableError) {
          return Response.json({ error: err.message, details: err.details }, { status: err.status });
        }
        log.error(`[datatables] ${(err as Error).stack ?? err}`);
        return Response.json({ error: (err as Error).message || "Internal error" }, { status: 500 });
      }
    };

  const name = (reqCtx: Context) => (reqCtx.params as Record<string, string>).name ?? "";
  const query = (reqCtx: Context) => new URL(reqCtx.request.url).searchParams;

  ctx.routes.register(
    "GET",
    "/tables",
    wrap(() => Response.json({ tables: store.listTables() })),
  );

  ctx.routes.register(
    "POST",
    "/tables",
    wrap((reqCtx) => {
      const body = check(CreateTableSchema, reqCtx.body);
      const table = store.createTable(body, getUserId(reqCtx.request));
      return Response.json({ table }, { status: 201 });
    }),
  );

  ctx.routes.register(
    "GET",
    "/tables/:name",
    wrap((reqCtx) => {
      const table = store.requireTable(name(reqCtx));
      return Response.json({ table: { ...table, rowCount: store.rowCount(table.name) } });
    }),
  );

  ctx.routes.register(
    "PUT",
    "/tables/:name",
    wrap((reqCtx) => Response.json(store.updateTable(name(reqCtx), check(UpdateTableSchema, reqCtx.body)))),
  );

  ctx.routes.register(
    "DELETE",
    "/tables/:name",
    wrap((reqCtx) => Response.json(store.deleteTable(name(reqCtx)))),
  );

  ctx.routes.register(
    "GET",
    "/tables/:name/rows",
    wrap((reqCtx) => {
      const params = query(reqCtx);
      const result = store.queryRows(name(reqCtx), {
        filters: parseFilterParam(params.get("filter")),
        sort: parseSortParam(params),
        limit: intParam(params, "limit"),
        offset: intParam(params, "offset"),
      });
      return Response.json(result);
    }),
  );

  ctx.routes.register(
    "POST",
    "/tables/:name/rows",
    wrap((reqCtx) => {
      const { rows } = check(InsertSchema, reqCtx.body);
      const result = store.insertRows(name(reqCtx), rows);
      return Response.json({ inserted: result.inserted, ids: result.ids }, { status: 201 });
    }),
  );

  ctx.routes.register(
    "PUT",
    "/tables/:name/rows/:id",
    wrap((reqCtx) => {
      const id = Number.parseInt((reqCtx.params as Record<string, string>).id ?? "", 10);
      if (Number.isNaN(id)) throw new DataTableError(400, "Invalid row id");
      const { values } = check(UpdateRowSchema, reqCtx.body);
      return Response.json({ row: store.updateRow(name(reqCtx), id, values) });
    }),
  );

  ctx.routes.register(
    "POST",
    "/tables/:name/rows/update",
    wrap((reqCtx) => {
      const { filters, values } = check(UpdateRowsSchema, reqCtx.body);
      return Response.json(store.updateRows(name(reqCtx), filters ?? [], values));
    }),
  );

  ctx.routes.register(
    "POST",
    "/tables/:name/rows/delete",
    wrap((reqCtx) => Response.json(store.deleteRows(name(reqCtx), check(DeleteRowsSchema, reqCtx.body)))),
  );

  ctx.routes.register(
    "POST",
    "/tables/:name/rows/upsert",
    wrap((reqCtx) => {
      const { rows, keyColumn } = check(UpsertSchema, reqCtx.body);
      return Response.json(store.upsertRows(name(reqCtx), rows, keyColumn));
    }),
  );

  ctx.routes.register(
    "POST",
    "/tables/:name/truncate",
    wrap((reqCtx) => Response.json(store.truncate(name(reqCtx)))),
  );

  ctx.routes.register(
    "GET",
    "/tables/:name/export",
    wrap(async (reqCtx) => {
      const params = query(reqCtx);
      const format = params.get("format") === "xlsx" ? "xlsx" : "csv";
      const table = store.requireTable(name(reqCtx));
      const rows = store.iterateRows(table.name, parseFilterParam(params.get("filter")), parseSortParam(params));
      const file = await exportTable(table, rows, format);
      return new Response(file.body, {
        headers: {
          "Content-Type": file.contentType,
          "Content-Disposition": `attachment; filename="${file.filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }),
  );

  ctx.routes.register(
    "POST",
    "/import/preview",
    wrap(async (reqCtx) => {
      const { bytes, filename } = await uploadedFile(reqCtx.body);
      const parsed = await parseFile(bytes, filename, {
        sheet: formField(reqCtx.body, "sheet"),
        delimiter: formField(reqCtx.body, "delimiter"),
      });
      return Response.json(buildPreview(parsed, formField(reqCtx.body, "headerRow") !== "false"));
    }),
  );

  ctx.routes.register(
    "POST",
    "/import",
    wrap(async (reqCtx) => {
      const { bytes, filename } = await uploadedFile(reqCtx.body);
      let rawOptions: unknown;
      try {
        rawOptions = JSON.parse(formField(reqCtx.body, "options") ?? "");
      } catch {
        throw new DataTableError(400, 'Missing or invalid "options" field (JSON)');
      }
      const options = check(ImportOptionsSchema, rawOptions);
      const result = await runImport(store, bytes, filename, options, getUserId(reqCtx.request));
      return Response.json(result);
    }),
  );
}
