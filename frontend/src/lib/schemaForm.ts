/**
 * Shared utilities for rendering form fields from JSON Schema objects.
 *
 * Extracted from SettingsForm.svelte so that both extension settings forms
 * and workflow step configuration forms can reuse the same logic.
 *
 * @module
 */

/** Supported input types that the schema form renderer can produce. */
export type SchemaInputType =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "enum"
  | "select"
  | "password"
  | "multiselect"
  | "tags"
  | "numberlist"
  | "stringlist"
  | "keyvalue"
  | "object"
  | "objectlist"
  | "objectrecord"
  | "variant"
  | "unsupported";

/** A single property descriptor from a JSON Schema `properties` object. */
export type SchemaProperty = Record<string, unknown>;

/**
 * Detect if a schema property is an enum (anyOf with const values).
 *
 * @param prop - The property schema object
 * @returns True if the property represents an enum
 */
export function isEnum(prop: SchemaProperty): boolean {
  const anyOf = prop.anyOf as Array<SchemaProperty> | undefined;
  if (!anyOf || !Array.isArray(anyOf)) return false;
  return anyOf.every((item) => "const" in item);
}

/**
 * Extract enum option values from an anyOf schema.
 *
 * @param prop - The property schema object
 * @returns Array of string option values
 */
export function getEnumOptions(prop: SchemaProperty): string[] {
  const anyOf = prop.anyOf as Array<SchemaProperty> | undefined;
  if (!anyOf) return [];
  return anyOf.filter((item) => "const" in item).map((item) => String(item.const));
}

/**
 * Extract the `availableItems` option values from a schema property.
 *
 * Populated at request time from a `dynamicItems` provider (or declared
 * statically). Used to offer suggestions for single-string `select` fields and
 * options for array `multiselect` fields.
 *
 * @param prop - The property schema object
 * @returns Array of string option values (empty when none are declared)
 */
export function getAvailableItems(prop: SchemaProperty): string[] {
  const items = prop.availableItems;
  if (!Array.isArray(items)) return [];
  return items.map((item) => String(item));
}

/**
 * Get a display label for a schema property.
 * Uses the `title` annotation if available, otherwise capitalizes the property key.
 *
 * @param key - The property key name
 * @param prop - The property schema object
 * @returns Human-readable label string
 */
export function getLabel(key: string, prop: SchemaProperty): string {
  if (typeof prop.title === "string") return prop.title;
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Determine the appropriate input type for rendering a schema property.
 *
 * @param schema - The property schema object
 * @returns The input type to use for rendering
 */
export function getInputType(schema: SchemaProperty): SchemaInputType {
  const prop = normalizeLooseUnion(schema);
  if (prop.sensitive === true) return "password";
  if (prop.type === "array" && Array.isArray(prop.availableItems)) return "multiselect";
  if (prop.type === "array" && isSimpleStringArray(prop)) {
    return normalizeLooseUnion(prop.items as SchemaProperty).multiline === true ? "stringlist" : "tags";
  }
  if (prop.type === "array" && isNumberArray(prop)) return "numberlist";
  if (prop.type === "array" && isFormObject(prop.items)) return "objectlist";
  if (isObjectWithProperties(prop)) return "object";
  if (getVariants(prop)) return "variant";
  const recordValue = getRecordValueSchema(prop);
  if (isPrimitive(recordValue)) return "keyvalue";
  if (isFormObject(recordValue)) return "objectrecord";
  if (isEnum(prop)) return "enum";
  if (prop.type === "boolean") return "boolean";
  if (prop.type === "number" || prop.type === "integer") return "number";
  if (prop.type === "string" && prop.multiline === true) return "textarea";
  // A single-string field with a suggestion list renders as a datalist-backed
  // input: it offers the known options as a dropdown while still accepting free
  // text (e.g. {{template}} expressions).
  if (prop.type === "string" && Array.isArray(prop.availableItems) && prop.availableItems.length > 0) return "select";
  if (prop.type === "string") return "text";
  return "unsupported";
}

/**
 * Check if an array property has simple string items (not objects or nested arrays).
 *
 * @param prop - The property schema object with type "array"
 * @returns True if items are plain strings
 */
function isSimpleStringArray(prop: SchemaProperty): boolean {
  const items = prop.items as SchemaProperty | undefined;
  if (!items || typeof items !== "object") return false;
  return normalizeLooseUnion(items).type === "string";
}

/**
 * Check if an array property has number/integer items.
 *
 * @param prop - The property schema object with type "array"
 * @returns True if items are numbers
 */
function isNumberArray(prop: SchemaProperty): boolean {
  const items = prop.items as SchemaProperty | undefined;
  if (!items) return false;
  return items.type === "number" || items.type === "integer";
}

/**
 * Check if a schema is an object with a declared `properties` map (a nested form).
 *
 * @param prop - The schema to check (may be undefined)
 * @returns True if the schema is an object with named properties
 */
function isObjectWithProperties(prop: unknown): boolean {
  if (!prop || typeof prop !== "object") return false;
  const p = prop as SchemaProperty;
  return p.type === "object" && !!p.properties && typeof p.properties === "object";
}

/**
 * Check if a schema renders as a nested form: an object with named properties
 * or a discriminated union of such objects.
 *
 * @param prop - The schema to check (may be undefined)
 * @returns True if a nested form can edit values of this schema
 */
function isFormObject(prop: unknown): boolean {
  if (!prop || typeof prop !== "object") return false;
  return isObjectWithProperties(prop) || getVariants(prop as SchemaProperty) !== undefined;
}

/**
 * Collapse a "loose" union to its plain string member, so it renders as a
 * text field. Typical case: a value the backend accepts as `string | object |
 * array` (TypeBox `Type.Union`), where text is the common form. Annotations of
 * the union (title, description, multiline, ...) take precedence over the
 * member's. Nested unions are searched; enums and unions without a plain
 * string member are returned unchanged. The result is marked `looseUnion`, so
 * the form can fall back to JSON editing for existing non-string values.
 *
 * @param prop - The schema to normalize
 * @returns The string member merged with the union's annotations, or `prop`
 */
function normalizeLooseUnion(prop: SchemaProperty): SchemaProperty {
  if (!Array.isArray(prop.anyOf) || isEnum(prop)) return prop;
  const member = findStringMember(prop.anyOf as SchemaProperty[]);
  if (!member) return prop;
  const { anyOf: _, ...annotations } = prop;
  return { ...member, ...annotations, type: "string", looseUnion: true };
}

/**
 * Find the first plain (non-const) string member of a union, searching nested
 * unions.
 *
 * @param members - The union members
 * @returns The string member, or undefined
 */
function findStringMember(members: SchemaProperty[]): SchemaProperty | undefined {
  for (const m of members) {
    if (!m || typeof m !== "object") continue;
    if (m.type === "string" && !("const" in m)) return m;
    if (Array.isArray(m.anyOf) && !isEnum(m)) {
      const nested = findStringMember(m.anyOf as SchemaProperty[]);
      if (nested) return nested;
    }
  }
  return undefined;
}

/**
 * Whether the current value of a field cannot be shown in its text inputs
 * because a loose union (see {@link normalizeLooseUnion}) holds a structured
 * value: the field itself, its list items, or its record values.
 *
 * @param prop - The normalized property schema
 * @param value - The current value
 * @returns True when the field must be edited as JSON
 */
export function hasNonTextValue(prop: SchemaProperty, value: unknown): boolean {
  const structured = (v: unknown) => v !== null && typeof v === "object";
  if (value === undefined || value === null) return false;
  const items = prop.items as SchemaProperty | undefined;
  if (prop.type === "array" && items?.looseUnion === true) return Array.isArray(value) && value.some(structured);
  if (getRecordValueSchema(prop)?.looseUnion === true)
    return structured(value) && Object.values(value).some(structured);
  return prop.looseUnion === true && structured(value);
}

/** One alternative of a discriminated union. */
export interface SchemaVariant {
  /** The discriminator value selecting this alternative. */
  value: string;
  /** The alternative's object schema. */
  schema: SchemaProperty;
}

/**
 * Detect a discriminated union: an `anyOf` of objects with named properties
 * that all declare the same property with a distinct `const` value (e.g.
 * `type: "choice" | "score"`).
 *
 * @param prop - The property schema
 * @returns The discriminator key and the alternatives, or undefined
 */
export function getVariants(prop: SchemaProperty): { discriminator: string; variants: SchemaVariant[] } | undefined {
  const anyOf = prop.anyOf as SchemaProperty[] | undefined;
  if (!Array.isArray(anyOf) || anyOf.length < 2 || !anyOf.every(isObjectWithProperties)) return undefined;
  const first = getProperties(anyOf[0]!);
  for (const key of Object.keys(first)) {
    const values = anyOf.map((member) => getProperties(member)[key]?.const);
    if (!values.every((v) => typeof v === "string")) continue;
    if (new Set(values).size !== values.length) continue;
    return {
      discriminator: key,
      variants: anyOf.map((member, i) => ({ value: values[i] as string, schema: member })),
    };
  }
  return undefined;
}

/**
 * Object schema of the nested form that edits a value of `prop`. For a
 * discriminated union this is the alternative selected by the value's
 * discriminator (the first one when unset), with the discriminator turned into
 * an enum over all alternatives, so the form offers switching. Other schemas
 * are returned unchanged.
 *
 * @param prop - An object schema or discriminated union
 * @param value - The current value
 * @returns The object schema to render
 */
export function getFormSchema(prop: SchemaProperty, value: unknown): SchemaProperty {
  const info = getVariants(prop);
  if (!info) return prop;
  const { discriminator, variants } = info;
  const current = (value as Record<string, unknown> | undefined)?.[discriminator];
  const selected = variants.find((v) => v.value === current) ?? variants[0]!;
  const { [discriminator]: discriminatorProp, ...rest } = getProperties(selected.schema);
  const required = Array.isArray(selected.schema.required) ? (selected.schema.required as string[]) : [];
  return {
    ...selected.schema,
    properties: {
      [discriminator]: {
        title: discriminatorProp?.title,
        description: discriminatorProp?.description,
        anyOf: variants.map((v) => ({ const: v.value })),
      },
      ...rest,
    },
    required: [discriminator, ...required.filter((k) => k !== discriminator)],
  };
}

/**
 * Apply an edit to a value of `prop` (see {@link getFormSchema}). When the
 * discriminator of a union changed, the value is rebuilt for the new
 * alternative: fields that render the same way in both are kept, the rest is
 * dropped and required fields are seeded.
 *
 * @param prop - An object schema or discriminated union
 * @param previous - The value before the edit
 * @param next - The edited value
 * @returns The value to store
 */
export function applyFormEdit(
  prop: SchemaProperty,
  previous: unknown,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const info = getVariants(prop);
  if (!info) return next;
  const before = (previous as Record<string, unknown> | undefined)?.[info.discriminator];
  if (before === next[info.discriminator]) return next;
  const oldProps = getProperties(getFormSchema(prop, previous));
  const newSchema = getFormSchema(prop, next);
  const newProps = getProperties(newSchema);
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    const oldProp = oldProps[key];
    const newProp = newProps[key];
    if (oldProp && newProp && getInputType(oldProp) === getInputType(newProp)) kept[key] = value;
  }
  return buildInitialValues(newSchema, kept);
}

/**
 * Check if a schema describes a primitive (string, number, integer, boolean) value.
 *
 * @param prop - The schema to check (may be undefined)
 * @returns True if the schema is a primitive type
 */
function isPrimitive(prop: SchemaProperty | undefined): boolean {
  if (!prop) return false;
  return prop.type === "string" || prop.type === "number" || prop.type === "integer" || prop.type === "boolean";
}

/**
 * Extract the value schema of a record/map property (`Type.Record(...)`).
 *
 * TypeBox serializes records as an object with a single `patternProperties`
 * entry; plain JSON Schema maps use `additionalProperties`. Objects with named
 * `properties` are not records.
 *
 * @param prop - The property schema object
 * @returns The value schema, or undefined when the property is not a record
 */
export function getRecordValueSchema(prop: SchemaProperty): SchemaProperty | undefined {
  if (prop.type !== "object" || prop.properties) return undefined;
  const pattern = prop.patternProperties as Record<string, SchemaProperty> | undefined;
  if (pattern && typeof pattern === "object") {
    const values = Object.values(pattern);
    return values.length === 1 ? normalizeLooseUnion(values[0]!) : undefined;
  }
  const additional = prop.additionalProperties;
  if (additional && typeof additional === "object") return normalizeLooseUnion(additional as SchemaProperty);
  return undefined;
}

/**
 * Split a comma-separated tag input into trimmed, non-empty entries. Commas
 * inside `{{...}}` template expressions (function arguments) do not split.
 *
 * @param raw - The raw input text
 * @returns The entries
 */
export function parseTagList(raw: string): string[] {
  const items: string[] = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw.startsWith("{{", i)) {
      depth++;
      current += "{{";
      i++;
    } else if (depth > 0 && raw.startsWith("}}", i)) {
      depth--;
      current += "}}";
      i++;
    } else if (raw[i] === "," && depth === 0) {
      items.push(current);
      current = "";
    } else {
      current += raw[i];
    }
  }
  items.push(current);
  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Get the appropriate empty/initial value for a property based on its type.
 *
 * @param prop - The property schema object
 * @returns A sensible default value for the property type
 */
export function getEmptyValue(prop: SchemaProperty): unknown {
  if (prop.type === "boolean") return false;
  if (prop.type === "number" || prop.type === "integer") return 0;
  if (prop.type === "array") return [];
  // Object/record fields (e.g. http-request `headers`) must default to an empty
  // object, never an empty string - an empty string fails object schema
  // validation at step-execution time ("Expected object").
  if (prop.type === "object") return {};
  if (isEnum(prop)) {
    const options = getEnumOptions(prop);
    return options.length > 0 ? options[0] : "";
  }
  return "";
}

/**
 * Extract the properties map from a JSON Schema object, normalized for form
 * rendering (loose unions become strings, see {@link normalizeLooseUnion}).
 *
 * @param schema - The root JSON Schema object
 * @returns Record of property key to property schema
 */
export function getProperties(schema: Record<string, unknown>): Record<string, SchemaProperty> {
  const properties = (schema.properties ?? {}) as Record<string, SchemaProperty>;
  const result: Record<string, SchemaProperty> = {};
  for (const [key, prop] of Object.entries(properties)) result[key] = normalizeProperty(prop);
  return result;
}

/**
 * Normalize a property for form rendering: loose unions become strings (see
 * {@link normalizeLooseUnion}), also as array items.
 *
 * @param prop - The property schema
 * @returns The normalized schema
 */
function normalizeProperty(prop: SchemaProperty): SchemaProperty {
  const normalized = normalizeLooseUnion(prop);
  const items = normalized.items as SchemaProperty | undefined;
  if (normalized.type !== "array" || !items || typeof items !== "object") return normalized;
  const normalizedItems = normalizeLooseUnion(items);
  if (normalizedItems === items) return normalized;
  return { ...normalized, items: normalizedItems, looseUnion: true };
}

/**
 * Build initial form values from a schema and optional existing values.
 * Uses existing values where present, then schema defaults, then empty values.
 *
 * @param schema - The JSON Schema object
 * @param existingValues - Optional pre-existing values to populate
 * @returns Record of property key to initial value
 */
export function buildInitialValues(
  schema: Record<string, unknown>,
  existingValues?: Record<string, unknown>,
): Record<string, unknown> {
  const properties = getProperties(schema);
  const required = Array.isArray(schema.required) ? new Set(schema.required as string[]) : new Set<string>();
  const vals: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    const prop = properties[key]!;
    if (existingValues && key in existingValues && existingValues[key] !== undefined) {
      vals[key] = existingValues[key];
    } else if (prop.default !== undefined) {
      vals[key] = prop.default;
    } else if (required.has(key)) {
      // Only seed an empty value for REQUIRED fields with no value/default.
      // Optional fields are intentionally omitted so they are not persisted as
      // empty placeholders (e.g. an optional object field must not be saved as
      // `""`, which would fail object validation). Form inputs already coalesce
      // `undefined` to a display value.
      vals[key] = getEmptyValue(prop);
    }
  }
  return vals;
}

/**
 * Move a list item to another position.
 *
 * @param list - The list to reorder (not mutated)
 * @param from - Current index of the item
 * @param to - Target index of the item
 * @returns A new list with the item moved (an unchanged copy when an index is out of range)
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}
