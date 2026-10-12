/**
 * Row models for the workflow editor's field builder (`FieldListEditor`), and
 * their conversion to and from what is stored in the workflow definition:
 *
 * - **Form mode**: a flat JSON Schema object (portal trigger `fields`,
 *   `humanTask` `form`), limited to what the portal form renderer supports
 *   (`portal/src/lib/form.ts`).
 * - **Shape mode**: the `outputSchema` shorthand (leaf type names, nested
 *   maps, `[item]` arrays).
 *
 * Parsing is lossless or fails: a value the rows cannot represent exactly
 * yields `ok: false`, and the editor falls back to raw JSON instead of
 * dropping keywords. Pure (no browser dependencies) so it can be unit-tested.
 */
import type { OutputSchemaShorthand, OutputSchemaShorthandValue } from "$shared/workflows";
import { translateCore as t } from "./i18nCore";

/** Input kinds of a form field (matching the portal renderer). */
export const FORM_FIELD_TYPES = ["text", "textarea", "date", "number", "integer", "boolean", "select"] as const;

/** Input kind of a form field. */
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** An option of a `select` field. */
export interface FormFieldOption {
  /** Submitted value. */
  value: string;
  /** Display label ("" = the value). */
  label: string;
}

/** One field of a form schema. */
export interface FormFieldRow {
  /** Property name. */
  key: string;
  /** Input kind. */
  type: FormFieldType;
  /** Display label (`title`; "" = the key). */
  label: string;
  /** Help text (`description`; "" = none). */
  description: string;
  /** Whether a value is required. */
  required: boolean;
  /** Default value as typed ("" = none); converted per type on output. */
  default: string;
  /** Options of a `select` field. */
  options: FormFieldOption[];
}

/** Leaf types of the output-schema shorthand. */
export const SHAPE_FIELD_TYPES = ["string", "number", "boolean", "object", "any"] as const;

/** Leaf type of a shape field. */
export type ShapeFieldType = (typeof SHAPE_FIELD_TYPES)[number];

/** One property of an output-schema shorthand. */
export interface ShapeFieldRow {
  /** Property name. */
  key: string;
  /** Type; `object` with children is a nested map, without one an open object. */
  type: ShapeFieldType;
  /** Whether the value is a list of this type. */
  array: boolean;
  /** Nested properties (only for `object`). */
  children: ShapeFieldRow[];
}

/** Result of converting a stored value into rows. */
export type RowsResult<T> = { ok: true; rows: T[] } | { ok: false; reason: string };

type JsonObject = Record<string, unknown>;

/** Root keywords of a form schema the rows can represent. */
const FORM_ROOT_KEYS = new Set(["type", "properties", "required"]);
/** Property keywords of a form field the rows can represent. */
const FORM_FIELD_KEYS = new Set(["type", "title", "description", "default", "format", "multiline", "enum", "anyOf"]);

/** Creates an empty form row. */
export function emptyFormRow(): FormFieldRow {
  return { key: "", type: "text", label: "", description: "", required: false, default: "", options: [] };
}

/** Creates an empty shape row. */
export function emptyShapeRow(): ShapeFieldRow {
  return { key: "", type: "string", array: false, children: [] };
}

/**
 * Whether a form row is untouched (as added by "Add field"). Blank rows are
 * skipped instead of reported, so adding a field does not flag an error.
 *
 * @param row - The row
 * @returns True when every property still has its initial value
 */
export function isBlankFormRow(row: FormFieldRow): boolean {
  return (
    !row.key.trim() &&
    row.type === "text" &&
    !row.label &&
    !row.description &&
    !row.required &&
    !row.default &&
    row.options.length === 0
  );
}

/**
 * Whether a shape row is untouched (as added by "Add field").
 *
 * @param row - The row
 * @returns True when every property still has its initial value
 */
export function isBlankShapeRow(row: ShapeFieldRow): boolean {
  return !row.key.trim() && row.type === "string" && !row.array && row.children.length === 0;
}

/** Whether a value is a plain (non-array) object. */
function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a key can be referenced as a plain template path segment
 * (`{{ trigger.payload.data.<key> }}`).
 *
 * @param key - The property name
 * @returns True for identifier-like keys
 */
export function isPlainKey(key: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(key);
}

/** Converts one property schema into a form row, or returns why it cannot. */
function propertyToRow(key: string, node: unknown, required: boolean): FormFieldRow | string {
  const unsupported = t("fieldBuilder.unsupportedField", { key });
  if (!isObject(node)) return unsupported;
  if (Object.keys(node).some((k) => !FORM_FIELD_KEYS.has(k))) return unsupported;
  const { title, description } = node;
  if (title !== undefined && typeof title !== "string") return unsupported;
  if (description !== undefined && typeof description !== "string") return unsupported;
  const row: FormFieldRow = {
    ...emptyFormRow(),
    key,
    label: title ?? "",
    description: description ?? "",
    required,
  };

  if (node.enum !== undefined || node.anyOf !== undefined) {
    if (node.type !== undefined && node.type !== "string") return unsupported;
    if (node.format !== undefined || node.multiline !== undefined) return unsupported;
    if (node.enum !== undefined && node.anyOf !== undefined) return unsupported;
    if (Array.isArray(node.enum) && node.enum.length > 0 && node.enum.every((v) => typeof v === "string")) {
      row.options = (node.enum as string[]).map((value) => ({ value, label: "" }));
    } else if (
      Array.isArray(node.anyOf) &&
      node.anyOf.length > 0 &&
      node.anyOf.every(
        (v) =>
          isObject(v) &&
          typeof v.const === "string" &&
          (v.title === undefined || typeof v.title === "string") &&
          Object.keys(v).every((k) => k === "const" || k === "title"),
      )
    ) {
      row.options = (node.anyOf as { const: string; title?: string }[]).map((v) => ({
        value: v.const,
        label: v.title ?? "",
      }));
    } else {
      return unsupported;
    }
    if (node.default !== undefined && typeof node.default !== "string") return unsupported;
    row.type = "select";
    row.default = (node.default as string | undefined) ?? "";
    return row;
  }

  switch (node.type) {
    case "string": {
      if (node.format !== undefined && node.format !== "date") return unsupported;
      if (node.multiline !== undefined && node.multiline !== true) return unsupported;
      if (node.format !== undefined && node.multiline !== undefined) return unsupported;
      if (node.default !== undefined && typeof node.default !== "string") return unsupported;
      row.type = node.format === "date" ? "date" : node.multiline ? "textarea" : "text";
      row.default = (node.default as string | undefined) ?? "";
      return row;
    }
    case "number":
    case "integer":
      if (node.format !== undefined || node.multiline !== undefined) return unsupported;
      if (node.default !== undefined && typeof node.default !== "number") return unsupported;
      row.type = node.type;
      row.default = node.default === undefined ? "" : String(node.default);
      return row;
    case "boolean":
      if (node.format !== undefined || node.multiline !== undefined) return unsupported;
      if (node.default !== undefined && typeof node.default !== "boolean") return unsupported;
      row.type = "boolean";
      row.default = node.default === undefined ? "" : String(node.default);
      return row;
    default:
      return unsupported;
  }
}

/**
 * Converts a form schema (portal `fields`, humanTask `form`) into rows.
 *
 * @param schema - The JSON Schema object, or undefined for none
 * @returns The rows, or why the schema cannot be edited as rows
 */
export function schemaToFormRows(schema: unknown): RowsResult<FormFieldRow> {
  if (schema === undefined || schema === null) return { ok: true, rows: [] };
  if (!isObject(schema)) return { ok: false, reason: t("fieldBuilder.notObjectSchema") };
  const extra = Object.keys(schema).find((k) => !FORM_ROOT_KEYS.has(k));
  if (extra) return { ok: false, reason: t("fieldBuilder.unsupportedKeyword", { keyword: extra }) };
  if (schema.type !== undefined && schema.type !== "object") {
    return { ok: false, reason: t("fieldBuilder.notObjectSchema") };
  }
  const properties = schema.properties ?? {};
  if (!isObject(properties)) return { ok: false, reason: t("fieldBuilder.notObjectSchema") };
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some((k) => typeof k !== "string" || !(k in properties))) {
    return { ok: false, reason: t("fieldBuilder.unsupportedKeyword", { keyword: "required" }) };
  }
  const rows: FormFieldRow[] = [];
  for (const [key, node] of Object.entries(properties)) {
    const row = propertyToRow(key, node, required.includes(key));
    if (typeof row === "string") return { ok: false, reason: row };
    rows.push(row);
  }
  return { ok: true, rows };
}

/** Converts a row's default text into the typed default, or undefined for none. */
function typedDefault(row: FormFieldRow): unknown {
  if (row.default === "") return undefined;
  if (row.type === "number" || row.type === "integer") return Number(row.default);
  if (row.type === "boolean") return row.default === "true";
  return row.default;
}

/**
 * Converts form rows into a JSON Schema object. Rows with an empty key are
 * skipped; call {@link validateFormRows} first to report them.
 *
 * @param rows - The rows
 * @returns The schema, or undefined when there are no fields
 */
export function formRowsToSchema(rows: FormFieldRow[]): JsonObject | undefined {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    const node: JsonObject = {};
    switch (row.type) {
      case "text":
        node.type = "string";
        break;
      case "textarea":
        node.type = "string";
        node.multiline = true;
        break;
      case "date":
        node.type = "string";
        node.format = "date";
        break;
      case "select":
        node.type = "string";
        if (row.options.some((o) => o.label !== "")) {
          node.anyOf = row.options.map((o) => (o.label ? { const: o.value, title: o.label } : { const: o.value }));
        } else {
          node.enum = row.options.map((o) => o.value);
        }
        break;
      default:
        node.type = row.type;
    }
    if (row.label) node.title = row.label;
    if (row.description) node.description = row.description;
    const def = typedDefault(row);
    if (def !== undefined) node.default = def;
    properties[key] = node;
    if (row.required) required.push(key);
  }
  if (Object.keys(properties).length === 0) return undefined;
  return required.length > 0 ? { type: "object", properties, required } : { type: "object", properties };
}

/**
 * Checks form rows: keys present and unique, select fields with options,
 * defaults matching the type. Blank rows are ignored.
 *
 * @param rows - The rows
 * @returns The first error message, or null when valid
 */
export function validateFormRows(rows: FormFieldRow[]): string | null {
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    if (isBlankFormRow(row)) continue;
    const key = row.key.trim();
    if (!key) return t("fieldBuilder.errors.emptyKey", { index: i + 1 });
    if (seen.has(key)) return t("fieldBuilder.errors.duplicateKey", { key });
    seen.add(key);
    if (row.type === "select") {
      if (row.options.length === 0) return t("fieldBuilder.errors.noOptions", { key });
      const values = new Set<string>();
      for (const option of row.options) {
        if (option.value === "") return t("fieldBuilder.errors.emptyOption", { key });
        if (values.has(option.value)) return t("fieldBuilder.errors.duplicateOption", { key, value: option.value });
        values.add(option.value);
      }
      if (row.default !== "" && !values.has(row.default)) return t("fieldBuilder.errors.badDefault", { key });
    }
    if ((row.type === "number" || row.type === "integer") && row.default.trim() !== "") {
      const n = Number(row.default);
      if (!Number.isFinite(n) || (row.type === "integer" && !Number.isInteger(n))) {
        return t("fieldBuilder.errors.badDefault", { key });
      }
    }
  }
  return null;
}

/** Converts one shorthand value into a shape row, or returns why it cannot. */
function shorthandValueToRow(key: string, value: OutputSchemaShorthandValue, path: string): ShapeFieldRow | string {
  let inner: unknown = value;
  let array = false;
  if (Array.isArray(inner)) {
    array = true;
    inner = inner[0];
    if (Array.isArray(inner)) return t("fieldBuilder.unsupportedNestedArray", { path });
  }
  if (typeof inner === "string") {
    if (!(SHAPE_FIELD_TYPES as readonly string[]).includes(inner)) {
      return t("fieldBuilder.unsupportedType", { path, type: inner });
    }
    return { key, type: inner as ShapeFieldType, array, children: [] };
  }
  if (isObject(inner)) {
    if (Object.keys(inner).length === 0) return t("fieldBuilder.unsupportedEmptyObject", { path });
    const children = shorthandToShapeRows(inner as OutputSchemaShorthand, path);
    if (!children.ok) return children.reason;
    return { key, type: "object", array, children: children.rows };
  }
  return t("fieldBuilder.unsupportedType", { path, type: String(inner) });
}

/**
 * Converts an output-schema shorthand into rows.
 *
 * @param shorthand - The shorthand, or undefined for none
 * @param prefix - Dot-path of the shorthand (for messages; internal)
 * @returns The rows, or why the shorthand cannot be edited as rows
 */
export function shorthandToShapeRows(
  shorthand: OutputSchemaShorthand | undefined,
  prefix = "",
): RowsResult<ShapeFieldRow> {
  if (!shorthand) return { ok: true, rows: [] };
  const rows: ShapeFieldRow[] = [];
  for (const [key, value] of Object.entries(shorthand)) {
    const row = shorthandValueToRow(key, value, prefix ? `${prefix}.${key}` : key);
    if (typeof row === "string") return { ok: false, reason: row };
    rows.push(row);
  }
  return { ok: true, rows };
}

/** Converts shape rows into a shorthand map, skipping rows without a key. */
function shapeRowsToMap(rows: ShapeFieldRow[]): OutputSchemaShorthand {
  const map: OutputSchemaShorthand = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    const nested = row.type === "object" ? shapeRowsToMap(row.children) : {};
    const inner: OutputSchemaShorthandValue = Object.keys(nested).length > 0 ? nested : row.type;
    map[key] = row.array ? [inner] : inner;
  }
  return map;
}

/**
 * Converts shape rows into an output-schema shorthand.
 *
 * @param rows - The rows
 * @returns The shorthand, or undefined when there are no properties
 */
export function shapeRowsToShorthand(rows: ShapeFieldRow[]): OutputSchemaShorthand | undefined {
  const map = shapeRowsToMap(rows);
  return Object.keys(map).length > 0 ? map : undefined;
}

/**
 * Checks shape rows: keys present and unique on every level. Blank rows are
 * ignored.
 *
 * @param rows - The rows
 * @param prefix - Dot-path of the level (for messages; internal)
 * @returns The first error message, or null when valid
 */
export function validateShapeRows(rows: ShapeFieldRow[], prefix = ""): string | null {
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    if (isBlankShapeRow(row)) continue;
    const key = row.key.trim();
    if (!key) {
      return prefix
        ? t("fieldBuilder.errors.emptyNestedKey", { path: prefix, index: i + 1 })
        : t("fieldBuilder.errors.emptyKey", { index: i + 1 });
    }
    const path = prefix ? `${prefix}.${key}` : key;
    if (seen.has(key)) return t("fieldBuilder.errors.duplicateKey", { key: path });
    seen.add(key);
    if (row.type === "object") {
      const error = validateShapeRows(row.children, path);
      if (error) return error;
    }
  }
  return null;
}
