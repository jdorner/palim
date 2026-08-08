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
  | "password"
  | "multiselect"
  | "tags"
  | "json"
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
 * Get a display label for a schema property.
 * Uses the `title` annotation if available, otherwise falls back to the property key.
 *
 * @param key - The property key name
 * @param prop - The property schema object
 * @returns Human-readable label string
 */
export function getLabel(key: string, prop: SchemaProperty): string {
  return typeof prop.title === "string" ? prop.title : key;
}

/**
 * Determine the appropriate input type for rendering a schema property.
 *
 * @param prop - The property schema object
 * @returns The input type to use for rendering
 */
export function getInputType(prop: SchemaProperty): SchemaInputType {
  if (prop.sensitive === true) return "password";
  if (prop.type === "array" && Array.isArray(prop.availableItems)) return "multiselect";
  if (prop.type === "array") {
    const items = prop.items as SchemaProperty | undefined;
    if (items && items.type === "object") return "json";
    return "tags";
  }
  if (isEnum(prop)) return "enum";
  if (prop.type === "boolean") return "boolean";
  if (prop.type === "number" || prop.type === "integer") return "number";
  if (prop.type === "string" && prop.multiline === true) return "textarea";
  if (prop.type === "string") return "text";
  return "unsupported";
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
  if (isEnum(prop)) {
    const options = getEnumOptions(prop);
    return options.length > 0 ? options[0] : "";
  }
  return "";
}

/**
 * Extract the properties map from a JSON Schema object.
 *
 * @param schema - The root JSON Schema object
 * @returns Record of property key to property schema
 */
export function getProperties(schema: Record<string, unknown>): Record<string, SchemaProperty> {
  return (schema.properties ?? {}) as Record<string, SchemaProperty>;
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
  const vals: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    const prop = properties[key]!;
    if (existingValues && key in existingValues && existingValues[key] !== undefined) {
      vals[key] = existingValues[key];
    } else if (prop.default !== undefined) {
      vals[key] = prop.default;
    } else {
      vals[key] = getEmptyValue(prop);
    }
  }
  return vals;
}
