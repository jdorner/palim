/**
 * Helpers for rendering a task's form from its JSON Schema.
 *
 * End-user forms are plain JSON Schema objects (not TypeBox), so this supports
 * the common subset: string (text, multi-line, date), number, integer,
 * boolean, and enumerations (`enum` or `anyOf`/`oneOf` of `const`). The server
 * validates the submitted data against the full schema.
 *
 * @module
 */

/** A JSON Schema node. */
export type JsonSchema = Record<string, unknown>;

/** How a form field is rendered. */
export type FieldKind = "text" | "textarea" | "date" | "number" | "integer" | "boolean" | "select" | "unsupported";

/** A field of the form. */
export interface FormField {
  /** Property name. */
  key: string;
  /** Label (schema `title`, else the key). */
  label: string;
  /** Help text (schema `description`). */
  description: string | null;
  /** Input kind. */
  kind: FieldKind;
  /** Whether a value is required. */
  required: boolean;
  /** Options of a `select` field. */
  options: { value: string | number; label: string }[];
  /** The property schema. */
  schema: JsonSchema;
}

/** Reads the options of an enumeration, or null when the node is none. */
function enumOptions(node: JsonSchema): { value: string | number; label: string }[] | null {
  if (Array.isArray(node.enum)) {
    return (node.enum as unknown[])
      .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
      .map((v) => ({ value: v, label: String(v) }));
  }
  const variants = (node.anyOf ?? node.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(variants) && variants.length > 0 && variants.every((v) => v && "const" in v)) {
    return variants.map((v) => ({
      value: v.const as string | number,
      label: typeof v.title === "string" ? v.title : String(v.const),
    }));
  }
  return null;
}

/** Determines how a property is rendered. */
function fieldKind(node: JsonSchema): FieldKind {
  if (enumOptions(node)) return "select";
  switch (node.type) {
    case "string":
      if (node.format === "date") return "date";
      if (node.multiline === true || (typeof node.maxLength === "number" && node.maxLength > 200)) return "textarea";
      return "text";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    default:
      return "unsupported";
  }
}

/**
 * Lists the fields of an object schema, in property order.
 *
 * @param schema - The form schema (an object schema)
 * @returns The fields
 */
export function formFields(schema: JsonSchema | null): FormField[] {
  if (!schema || typeof schema.properties !== "object" || schema.properties === null) return [];
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(schema.properties as Record<string, JsonSchema>).map(([key, node]) => ({
    key,
    label: typeof node.title === "string" ? node.title : key,
    description: typeof node.description === "string" ? node.description : null,
    kind: fieldKind(node),
    required: required.has(key),
    options: enumOptions(node) ?? [],
    schema: node,
  }));
}

/**
 * Initial values: schema defaults, `false` for booleans, otherwise empty.
 *
 * @param fields - The form fields
 * @returns The initial value per key
 */
export function initialValues(fields: FormField[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.schema.default !== undefined) values[field.key] = field.schema.default;
    else if (field.kind === "boolean") values[field.key] = false;
    else values[field.key] = "";
  }
  return values;
}

/**
 * Converts the edited values into the data to submit: empty optional fields
 * are omitted and numbers are parsed.
 *
 * @param fields - The form fields
 * @param values - The edited values
 * @returns The data, plus the keys of required fields left empty
 */
export function collectData(
  fields: FormField[],
  values: Record<string, unknown>,
): { data: Record<string, unknown>; missing: string[] } {
  const data: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const field of fields) {
    const raw = values[field.key];
    const empty = raw === "" || raw === undefined || raw === null;
    if (empty) {
      if (field.required) missing.push(field.key);
      continue;
    }
    if (field.kind === "number" || field.kind === "integer") {
      const n = Number(raw);
      data[field.key] = Number.isNaN(n) ? raw : n;
    } else if (field.kind === "select" && field.options.some((o) => typeof o.value === "number")) {
      const option = field.options.find((o) => String(o.value) === String(raw));
      data[field.key] = option ? option.value : raw;
    } else {
      data[field.key] = raw;
    }
  }
  return { data, missing };
}
