/**
 * Excel step type handler — executes the "excel" workflow step type.
 *
 * Supports two modes:
 * - `create`: Generates a new .xlsx file from the provided config and data.
 * - `append`: Adds rows to an existing .xlsx file (errors if file does not exist).
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { StepExecutionContext, StepTypeHandler } from "@ext/types";
import { Value } from "@sinclair/typebox/value";
import { formatValidationErrors } from "@src/utils/validation";
import type { WriteSheet } from "hucre";
import { openXlsx, saveXlsx, writeXlsx } from "hucre/xlsx";
import type { ColumnDef, ExcelStepConfig } from "./schemas";
import { ExcelStepConfigSchema } from "./schemas";

/**
 * Determines whether a column expects numeric values.
 * Uses explicit `type` field first, then infers from `numFmt` patterns.
 *
 * @param col - The column definition
 * @returns `true` if the column expects numeric values
 */
function isNumericColumn(col: ColumnDef): boolean {
  if (col.type === "number") return true;
  if (col.type === "string" || col.type === "date") return false;
  // Infer from numFmt: patterns with #, 0, or currency symbols are numeric
  if (col.numFmt) {
    return /[#0]/.test(col.numFmt);
  }
  return false;
}

/**
 * Coerces a cell value to the appropriate type based on column definition.
 *
 * - Numeric columns: parses strings as numbers, handling both '.' and ',' decimal separators.
 *   The heuristic: if the string contains exactly one comma and no dots, treat comma as decimal.
 *   If it contains both dots and commas, dots are thousand separators (European format).
 * - Date columns: currently passed through as-is (string dates are common in Excel).
 * - String columns: no transformation.
 *
 * @param value - The raw value from JSON data
 * @param col - The column definition with type/numFmt hints
 * @returns The coerced value suitable for Excel cell storage
 */
function coerceValue(value: unknown, col: ColumnDef): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value;

  if (typeof value === "string") {
    if (!isNumericColumn(col)) return value;

    // Try to parse as number, handling locale variations
    const trimmed = value.trim();
    if (trimmed === "") return null;

    // If it's already a valid JS number string, parse directly
    const directParse = Number(trimmed);
    if (!Number.isNaN(directParse)) return directParse;

    // Handle European format: "1.234,56" or "5,55"
    // Heuristic: if last separator is comma, it's the decimal separator
    const lastComma = trimmed.lastIndexOf(",");
    const lastDot = trimmed.lastIndexOf(".");

    if (lastComma > lastDot) {
      // Comma is the decimal separator (European: "1.234,56" or "5,55")
      const normalized = trimmed.replace(/\./g, "").replace(",", ".");
      const parsed = Number(normalized);
      if (!Number.isNaN(parsed)) return parsed;
    }

    // Could not parse — return as string (will appear as text in Excel)
    return value;
  }

  return String(value);
}

/**
 * Strips markdown code fences from a string.
 *
 * LLMs frequently wrap JSON output in ` ```json ... ``` ` blocks even when
 * instructed not to. This function reliably extracts the content between fences.
 * Handles: ` ```json`, ` ``` `, and variations with/without language tags.
 *
 * @param input - The raw string that may contain fenced content
 * @returns The content without fences, or the original string if no fences found
 */
function stripMarkdownFences(input: string): string {
  const trimmed = input.trim();
  // Match opening fence with optional language tag, content, and closing fence
  const fenceMatch = trimmed.match(/^```(?:\w*)\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch?.[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

/** Result returned by the excel step handler. */
export interface ExcelStepResult {
  /** Absolute path to the written file. */
  filePath: string;
  /** Number of data rows written in this execution. */
  rowCount: number;
  /** Total rows in the file after this execution (append mode only). */
  totalRows?: number;
  /** The mode used for this execution. */
  mode: "create" | "append";
}

/**
 * Resolves template expressions in a sheet's data field.
 *
 * If `data` is a string (template expression), resolves it and parses the
 * result as JSON. If it's already an array, returns it as-is.
 *
 * @param data - The raw data field (string template or array)
 * @param ctx - Step execution context with template resolution
 * @returns Parsed array of row objects
 */
async function resolveSheetData(
  data: string | unknown[],
  ctx: StepExecutionContext,
): Promise<Record<string, unknown>[]> {
  if (Array.isArray(data)) {
    return data as Record<string, unknown>[];
  }

  // Resolve template expression
  const { resolved, warnings } = await ctx.resolveTemplate(data);
  for (const w of warnings) {
    await ctx.jobLog(`Warning (data template): ${w}`);
  }

  // Strip markdown code fences if present (LLMs often wrap JSON in ```json ... ```)
  const cleaned = stripMarkdownFences(resolved);

  // Parse the resolved string as JSON
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed as Record<string, unknown>[];
    }
    // If it's a single object, wrap in array
    if (typeof parsed === "object" && parsed !== null) {
      return [parsed as Record<string, unknown>];
    }
    throw new Error(`Expected array or object, got ${typeof parsed}`);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Failed to parse data as JSON: ${err.message}. Resolved value: ${cleaned.slice(0, 200)}`);
    }
    throw err;
  }
}

/**
 * Executes the excel step in "create" mode.
 * Generates a new .xlsx file from scratch using hucre's writeXlsx.
 *
 * @param config - Validated excel step configuration
 * @param resolvedFilename - The resolved output filename
 * @param ctx - Step execution context
 * @returns The step result with file path and row count
 */
async function executeCreateMode(
  config: ExcelStepConfig,
  resolvedFilename: string,
  ctx: StepExecutionContext,
): Promise<ExcelStepResult> {
  let totalRows = 0;

  // Build hucre sheet definitions
  const hucreSheets: WriteSheet[] = [];

  for (const sheetDef of config.sheets) {
    const rows = await resolveSheetData(sheetDef.data, ctx);
    totalRows += rows.length;

    hucreSheets.push({
      name: sheetDef.name,
      columns: sheetDef.columns.map((col) => ({
        header: col.header,
        key: col.key,
        ...(col.width ? { width: col.width } : {}),
        ...(col.numFmt ? { numFmt: col.numFmt } : {}),
        style: { font: { bold: true } },
      })),
      data: rows.map((row) => {
        const coerced: Record<string, string | number | boolean | Date | null> = {};
        for (const col of sheetDef.columns) {
          coerced[col.key] = coerceValue(row[col.key], col);
        }
        return coerced;
      }),
    });
  }

  // Generate the Excel file
  const buffer = await writeXlsx({ sheets: hucreSheets });

  // Resolve output path
  const { resolved: resolvedPath } = await ctx.resolveTemplate(config.path);
  const outputDir = path.join(ctx.workDir, resolvedPath);
  await mkdir(outputDir, { recursive: true });

  const filePath = path.join(outputDir, resolvedFilename);
  await Bun.write(filePath, buffer);

  await ctx.jobLog(`Created ${resolvedFilename} (${totalRows} rows across ${hucreSheets.length} sheet(s))`);

  return { filePath, rowCount: totalRows, mode: "create" };
}

/**
 * Executes the excel step in "append" mode.
 * Reads an existing .xlsx file, appends rows to the target sheet, and saves it back.
 * Errors if the file does not exist.
 *
 * @param config - Validated excel step configuration
 * @param resolvedFilename - The resolved output filename
 * @param ctx - Step execution context
 * @returns The step result with file path, rows added, and total rows
 */
async function executeAppendMode(
  config: ExcelStepConfig,
  resolvedFilename: string,
  ctx: StepExecutionContext,
): Promise<ExcelStepResult> {
  // Resolve output path
  const { resolved: resolvedPath } = await ctx.resolveTemplate(config.path);
  const outputDir = path.join(ctx.workDir, resolvedPath);
  const filePath = path.join(outputDir, resolvedFilename);

  // Verify file exists
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`Append mode: file does not exist at ${filePath}. Use mode "create" to generate a new file first.`);
  }

  // Read existing workbook
  const existingBuffer = new Uint8Array(await file.arrayBuffer());
  const workbook = await openXlsx(existingBuffer);

  // Process each sheet definition (typically just one for append)
  let totalAppended = 0;

  for (let i = 0; i < config.sheets.length; i++) {
    const sheetDef = config.sheets[i]!;
    const sheetIndex = i;

    // Access target sheet by index
    if (sheetIndex >= workbook.sheets.length) {
      throw new Error(
        `Append mode: sheet index ${sheetIndex} does not exist in the file (file has ${workbook.sheets.length} sheet(s))`,
      );
    }

    const targetSheet = workbook.sheets[sheetIndex]!;

    // Validate column count: the config defines the expected columns, and
    // the existing file's first row (header) should match in count.
    const expectedColCount = sheetDef.columns.length;
    const existingColCount = targetSheet.rows.length > 0 ? (targetSheet.rows[0]?.length ?? 0) : 0;

    if (existingColCount > 0 && existingColCount !== expectedColCount) {
      throw new Error(
        `Append mode: column count mismatch on sheet "${targetSheet.name}". ` +
          `Config defines ${expectedColCount} column(s) but existing file has ${existingColCount} column(s).`,
      );
    }

    // Resolve data
    const rows = await resolveSheetData(sheetDef.data, ctx);
    totalAppended += rows.length;

    // Map data objects to row arrays using column key order and append
    for (const row of rows) {
      const rowArray = sheetDef.columns.map((col) => coerceValue(row[col.key], col));
      targetSheet.rows.push(rowArray);
    }
  }

  // Save back to disk
  const outputBuffer = await saveXlsx(workbook);
  await Bun.write(filePath, outputBuffer);

  // Calculate total data rows (excluding header row)
  const totalRows = workbook.sheets[0] ? workbook.sheets[0].rows.length - 1 : 0;

  await ctx.jobLog(`Appended ${totalAppended} row(s) to ${resolvedFilename} (total: ${totalRows} data rows)`);

  return { filePath, rowCount: totalAppended, totalRows, mode: "append" };
}

/**
 * Creates the StepTypeHandler for the "excel" workflow step type.
 *
 * @returns The configured StepTypeHandler
 */
export function createExcelHandler(): StepTypeHandler {
  return {
    schema: ExcelStepConfigSchema,
    label: "Excel Writer",
    icon: "📊",

    async execute(stepDef: Record<string, unknown>, ctx: StepExecutionContext): Promise<ExcelStepResult> {
      // Extract config fields (strip slug and type which are handled by the workflow engine)
      const { slug: _slug, type: _type, ...configFields } = stepDef;

      // Validate config against schema
      if (!Value.Check(ExcelStepConfigSchema, configFields)) {
        const errorMsg = formatValidationErrors(ExcelStepConfigSchema, configFields);
        throw new Error(`Invalid excel step configuration: ${errorMsg}`);
      }

      const config = configFields as ExcelStepConfig;

      // Resolve filename template
      const { resolved: resolvedFilename, warnings: fnWarnings } = await ctx.resolveTemplate(config.filename);
      for (const w of fnWarnings) {
        await ctx.jobLog(`Warning (filename template): ${w}`);
      }

      if (config.mode === "create") {
        return executeCreateMode(config, resolvedFilename, ctx);
      }

      if (config.mode === "append") {
        return executeAppendMode(config, resolvedFilename, ctx);
      }

      throw new Error(`Unknown excel step mode: ${(config as { mode: string }).mode}`);
    },
  };
}
