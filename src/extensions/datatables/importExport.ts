/**
 * CSV/XLSX parsing, schema inference, and export for data tables.
 *
 * @module
 */

import { type CellValue, calculateColumnWidth } from "hucre";
import { parseCsv, writeCsv } from "hucre/csv";
import { readXlsx, writeXlsx } from "hucre/xlsx";
import { formatCell, isEmpty, parseDate, parseDateTime, parseNumber } from "./coerce";
import { DataTableError } from "./errors";
import type { ColumnDef, ColumnType, FileFormat, ImportPreview, RowRecord, TableDef } from "./types";
import { COLUMN_KEY_PATTERN, slugify } from "./types";

/** Maximum accepted upload size. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/** Maximum number of data rows per import. */
export const MAX_IMPORT_ROWS = 100_000;

/** Rows sampled per column for type inference. */
const INFERENCE_SAMPLE = 1000;

/** Rows included in an import preview. */
const PREVIEW_ROWS = 50;

/** A parsed upload: all sheets' names plus the selected sheet's raw rows. */
export interface ParsedFile {
  /** File format. */
  format: FileFormat;
  /** Sheet names (`["csv"]` for CSV). */
  sheets: string[];
  /** Selected sheet. */
  sheet: string;
  /** Raw rows of the selected sheet (header row included). */
  rows: unknown[][];
}

/** Header/data split of a sheet. */
export interface SheetData {
  /** Column headers (generated when the file has no header row). */
  headers: string[];
  /** Data rows, padded to the header width. */
  data: unknown[][];
}

/**
 * Detects the file format from content (ZIP magic) and file name.
 *
 * @param bytes - File content
 * @param filename - Original file name
 * @returns The detected format
 * @throws {DataTableError} 400 for unsupported formats
 */
export function detectFormat(bytes: Uint8Array, filename: string): FileFormat {
  const lower = filename.toLowerCase();
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) {
    if (lower.endsWith(".xls")) throw new DataTableError(400, "Legacy .xls files are not supported; save as .xlsx");
    return "xlsx";
  }
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".ods")) {
    throw new DataTableError(400, `Unsupported or corrupt spreadsheet "${filename}"; use .xlsx or .csv`);
  }
  return "csv";
}

/**
 * Decodes CSV bytes as UTF-8, falling back to Windows-1252 (common for
 * Excel CSV exports) when the content is not valid UTF-8.
 *
 * @param bytes - File content
 * @returns The decoded text
 */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/**
 * Parses an uploaded CSV or XLSX file.
 *
 * @param bytes - File content
 * @param filename - Original file name (format hint)
 * @param options - `sheet`: XLSX sheet name (defaults to the first); `delimiter`: CSV delimiter (auto-detected)
 * @returns The parsed sheet rows
 * @throws {DataTableError} 400 for unreadable files, unknown sheets, or files exceeding limits
 */
export async function parseFile(
  bytes: Uint8Array,
  filename: string,
  options: { sheet?: string; delimiter?: string } = {},
): Promise<ParsedFile> {
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new DataTableError(400, `File is too large (max ${MAX_IMPORT_BYTES / 1024 / 1024} MB)`);
  }
  const format = detectFormat(bytes, filename);
  let parsed: ParsedFile;
  if (format === "xlsx") {
    let workbook: Awaited<ReturnType<typeof readXlsx>>;
    try {
      workbook = await readXlsx(bytes, { maxRows: MAX_IMPORT_ROWS + 1 });
    } catch (err) {
      throw new DataTableError(400, `Could not read spreadsheet: ${(err as Error).message}`);
    }
    const visible = workbook.sheets.filter((s) => !s.hidden && !s.veryHidden);
    const sheets = (visible.length > 0 ? visible : workbook.sheets).map((s) => s.name);
    const name = options.sheet || sheets[0];
    const sheet = workbook.sheets.find((s) => s.name === name);
    if (!sheet || name === undefined) throw new DataTableError(400, `Sheet "${options.sheet}" not found`);
    parsed = { format, sheets, sheet: name, rows: sheet.rows };
  } else {
    let rows: CellValue[][];
    try {
      rows = parseCsv(decodeText(bytes), {
        delimiter: options.delimiter || undefined,
        skipEmptyRows: true,
        maxRows: MAX_IMPORT_ROWS + 1,
      });
    } catch (err) {
      throw new DataTableError(400, `Could not read CSV: ${(err as Error).message}`);
    }
    parsed = { format, sheets: ["csv"], sheet: "csv", rows };
  }
  // Drop fully empty trailing/intermediate rows.
  parsed.rows = parsed.rows.filter((row) => row.some((cell) => !isEmpty(cell)));
  return parsed;
}

/**
 * Splits raw rows into headers and data rows.
 *
 * @param rows - Raw rows
 * @param headerRow - Whether the first row holds column headers
 * @returns Headers and width-normalized data rows
 * @throws {DataTableError} 400 when the sheet has more than {@link MAX_IMPORT_ROWS} data rows
 */
export function splitHeader(rows: readonly unknown[][], headerRow: boolean): SheetData {
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const first = headerRow ? (rows[0] ?? []) : [];
  const headers = Array.from({ length: width }, (_, i) => {
    const h = first[i];
    return isEmpty(h) ? `Column ${i + 1}` : formatCell(h instanceof Date ? h.toISOString() : h).trim();
  });
  const data = (headerRow ? rows.slice(1) : rows).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null));
  if (data.length > MAX_IMPORT_ROWS) {
    throw new DataTableError(400, `Too many rows (max ${MAX_IMPORT_ROWS.toLocaleString("en")})`);
  }
  return { headers, data };
}

/**
 * Derives a column key from a header: lowercase ASCII, umlauts transliterated,
 * other characters collapsed to `_`, deduplicated against `used`.
 *
 * @param header - Header text
 * @param index - Column index (fallback key)
 * @param used - Keys already taken (updated in place)
 * @returns A valid, unique column key
 */
export function slugifyKey(header: string, index: number, used: Set<string>): string {
  let base = slugify(header);
  if (!/^[a-z]/.test(base)) base = base ? `c_${base}` : `column_${index + 1}`;
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
  if (!COLUMN_KEY_PATTERN.test(key)) key = `column_${index + 1}`;
  used.add(key);
  return key;
}

/** Whether a string looks like an identifier that must stay text (leading zeros, very long digit runs). */
function isCodeLike(s: string): boolean {
  return /^[+-]?0\d/.test(s) || /^\d{16,}$/.test(s);
}

/** Checks one non-empty value against a candidate type. */
function fitsType(type: ColumnType, value: unknown): boolean {
  if (value instanceof Date) return type === "date" || type === "datetime";
  if (typeof value === "boolean") return type === "boolean";
  if (typeof value === "number") return type === "number" || (type === "integer" && Number.isInteger(value));
  const s = String(value).trim();
  switch (type) {
    case "integer": {
      const n = isCodeLike(s) ? undefined : parseNumber(s);
      return n !== undefined && Number.isInteger(n) && /^[+-]?[\d.,\s]+$/.test(s);
    }
    case "number":
      return !isCodeLike(s) && parseNumber(s) !== undefined;
    case "boolean":
      return /^(true|false|yes|no|ja|nein|wahr|falsch)$/i.test(s);
    case "date":
      return parseDate(s) !== undefined && !/[T ]\d/.test(s);
    case "datetime":
      return parseDateTime(s) !== undefined;
    default:
      return true;
  }
}

/**
 * Infers the narrowest column type that fits every non-empty sampled value.
 *
 * Order: integer, number, boolean, date, datetime, text. Date cells from XLSX
 * become `date` when they all fall on UTC midnight, `datetime` otherwise.
 *
 * @param values - Column values
 * @returns The inferred type (`text` for empty columns)
 */
export function inferType(values: readonly unknown[]): ColumnType {
  const sample = values.filter((v) => !isEmpty(v)).slice(0, INFERENCE_SAMPLE);
  if (sample.length === 0) return "text";
  if (sample.every((v) => v instanceof Date)) {
    return sample.every((v) => (v as Date).getTime() % 86_400_000 === 0) ? "date" : "datetime";
  }
  const candidates: ColumnType[] = ["integer", "number", "boolean", "date", "datetime"];
  return candidates.find((type) => sample.every((v) => fitsType(type, v))) ?? "text";
}

/**
 * Infers column definitions from headers and data rows.
 *
 * @param headers - Column headers
 * @param data - Data rows
 * @returns Columns aligned with `headers`
 */
export function inferColumns(headers: readonly string[], data: readonly unknown[][]): ColumnDef[] {
  const used = new Set<string>();
  return headers.map((header, i) => ({
    key: slugifyKey(header, i, used),
    label: header,
    type: inferType(data.map((r) => r[i])),
  }));
}

/**
 * Builds the import preview for a parsed file.
 *
 * @param parsed - The parsed file
 * @param headerRow - Whether the first row holds headers
 * @returns Headers, inferred columns, and sample rows
 */
export function buildPreview(parsed: ParsedFile, headerRow: boolean): ImportPreview {
  const { headers, data } = splitHeader(parsed.rows, headerRow);
  return {
    sheets: parsed.sheets,
    sheet: parsed.sheet,
    headers,
    columns: inferColumns(headers, data),
    sampleRows: data
      .slice(0, PREVIEW_ROWS)
      .map((r) => r.map((c) => (c instanceof Date ? c.toISOString() : formatCell(c)))),
    totalRows: data.length,
  };
}

/**
 * Builds a default header-to-column mapping by matching headers against
 * column keys and labels (case-insensitive, then by slug).
 *
 * @param headers - File headers
 * @param columns - Target table columns
 * @returns `{ columnKey: headerIndex }` for every matched column
 */
export function defaultMapping(headers: readonly string[], columns: readonly ColumnDef[]): Record<string, number> {
  const mapping: Record<string, number> = {};
  const norm = (s: string) => s.trim().toLowerCase();
  headers.forEach((header, i) => {
    const slug = slugifyKey(header, i, new Set());
    const col =
      columns.find((c) => norm(c.label) === norm(header) || c.key === norm(header)) ??
      columns.find((c) => c.key === slug);
    if (col && mapping[col.key] === undefined) mapping[col.key] = i;
  });
  return mapping;
}

/**
 * Converts data rows to row objects using a column mapping.
 *
 * @param data - Data rows
 * @param mapping - `{ columnKey: headerIndex }`
 * @returns Raw row objects (values still uncoerced)
 */
export function mapRows(data: readonly unknown[][], mapping: Record<string, number>): Record<string, unknown>[] {
  const entries = Object.entries(mapping);
  return data.map((r) => {
    const row: Record<string, unknown> = {};
    for (const [key, index] of entries) row[key] = r[index] ?? null;
    return row;
  });
}

/** Upper bound for auto-fitted XLSX column widths (Excel character units), so long text does not produce huge columns. */
const MAX_XLSX_COLUMN_WIDTH = 60;

/** XLSX number formats per date column type. */
const XLSX_DATE_FORMATS: Partial<Record<ColumnType, string>> = {
  date: "yyyy-mm-dd",
  datetime: "yyyy-mm-dd hh:mm:ss",
};

/** A rendered export file. */
export interface ExportFile {
  /** File content. */
  body: Uint8Array | string;
  /** MIME type. */
  contentType: string;
  /** Suggested file name. */
  filename: string;
}

/**
 * Converts a stored value to a spreadsheet cell.
 *
 * @param column - The column
 * @param value - The stored value
 * @param format - Target format
 * @returns The cell value
 */
function toCell(column: ColumnDef, value: unknown, format: FileFormat): CellValue {
  if (value === null || value === undefined) return null;
  if (format === "xlsx" && (column.type === "date" || column.type === "datetime") && typeof value === "string") {
    const d = new Date(column.type === "date" ? `${value}T00:00:00Z` : value);
    return Number.isNaN(d.getTime()) ? value : d;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

/**
 * Derives a sheet name Excel accepts (hucre rejects invalid names on write):
 * no `\ / ? * [ ] :`, no leading/trailing apostrophe, at most 31 chars, not the reserved "History".
 *
 * @param label - The table label
 * @returns A valid sheet name
 */
export function xlsxSheetName(label: string): string {
  const name = label
    .replace(/[\\/?*[\]:]/g, " ")
    .slice(0, 31)
    .replace(/^[\s']+|[\s']+$/g, "");
  if (name.toLowerCase() === "history") return `${name} 1`;
  return name || "Sheet1";
}

/**
 * Renders table rows as CSV (UTF-8 with BOM, formula-escaped) or XLSX.
 * Headers are the column labels.
 *
 * @param table - The table
 * @param rows - Rows to export
 * @param format - Output format
 * @returns The export file
 */
export async function exportTable(table: TableDef, rows: Iterable<RowRecord>, format: FileFormat): Promise<ExportFile> {
  const header = table.columns.map((c) => c.label);
  const body: CellValue[][] = [];
  for (const row of rows) body.push(table.columns.map((c) => toCell(c, row[c.key], format)));
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "csv") {
    return {
      body: writeCsv([header, ...body], { bom: true, escapeFormulae: true }),
      contentType: "text/csv; charset=utf-8",
      filename: `${table.name}-${stamp}.csv`,
    };
  }
  const sheetRows = [header, ...body];
  // Auto-fit: widths are computed from the content at write time (XLSX has no fit-on-open flag)
  const columns = table.columns.map((column, i) => {
    const numFmt = XLSX_DATE_FORMATS[column.type];
    return {
      width: calculateColumnWidth(
        sheetRows.map((row) => row[i] ?? null),
        { numFmt, maxWidth: MAX_XLSX_COLUMN_WIDTH },
      ),
      ...(numFmt ? { numFmt } : {}),
    };
  });
  const bytes = await writeXlsx({
    sheets: [
      {
        name: xlsxSheetName(table.label),
        rows: sheetRows,
        columns,
        freezePane: { rows: 1, columns: 0 },
      },
    ],
  });
  return {
    body: bytes as Uint8Array,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    filename: `${table.name}-${stamp}.xlsx`,
  };
}
