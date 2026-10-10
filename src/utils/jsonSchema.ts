/**
 * Validation of values against plain JSON Schema documents.
 *
 * TypeBox's `Value.Check` only understands schemas built with TypeBox (they
 * carry a `Kind` symbol); a plain JSON Schema parsed from JSON - such as a
 * workflow `waitFor` step's `inputSchema` - makes it throw "Unknown type".
 * This module converts the commonly used JSON Schema subset into an
 * equivalent TypeBox schema so it can be checked with the usual tools.
 *
 * Supported: `type` (string, number, integer, boolean, null, array, object,
 * or an array of these), `properties`, `required`, `additionalProperties`,
 * `items`, `enum`, `const`, `anyOf`, `oneOf`, `allOf`, and the numeric, string
 * length, `pattern`, and array size constraints. Other keywords (e.g. `format`,
 * `$ref`) are ignored, so a node using only those accepts any value.
 *
 * @module
 */

import { Kind, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** A single validation error. */
export interface JsonSchemaValidationError {
  /** JSON pointer of the offending value. */
  path: string;
  /** Validation message. */
  message: string;
}

/** Result of {@link validateJsonSchema}. */
export type JsonSchemaValidationResult = { valid: true } | { valid: false; errors: JsonSchemaValidationError[] };

/** A JSON Schema node as a loosely typed record. */
type JsonSchemaNode = Record<string, unknown>;

/** Copies the listed keywords from a node when they are present. */
function pick(node: JsonSchemaNode, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (node[key] !== undefined) out[key] = node[key];
  }
  return out;
}

const NUMBER_KEYWORDS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"] as const;
const STRING_KEYWORDS = ["minLength", "maxLength", "pattern"] as const;
const ARRAY_KEYWORDS = ["minItems", "maxItems", "uniqueItems"] as const;

/** Converts a JSON literal to a TypeBox literal (or null) schema. */
function literal(value: unknown): TSchema {
  if (value === null) return Type.Null();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return Type.Literal(value);
  }
  // Object/array literals cannot be expressed as TypeBox literals.
  return Type.Unknown();
}

/** Converts a node for a single JSON Schema `type` name. */
function convertTyped(node: JsonSchemaNode, type: string): TSchema {
  switch (type) {
    case "string":
      return Type.String(pick(node, STRING_KEYWORDS));
    case "number":
      return Type.Number(pick(node, NUMBER_KEYWORDS));
    case "integer":
      return Type.Integer(pick(node, NUMBER_KEYWORDS));
    case "boolean":
      return Type.Boolean();
    case "null":
      return Type.Null();
    case "array":
      return Type.Array(node.items !== undefined ? jsonSchemaToTypeBox(node.items) : Type.Unknown(), {
        ...pick(node, ARRAY_KEYWORDS),
      });
    case "object":
      return convertObject(node);
    default:
      return Type.Unknown();
  }
}

/** Converts an object node (`properties`, `required`, `additionalProperties`). */
function convertObject(node: JsonSchemaNode): TSchema {
  const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
  const properties: Record<string, TSchema> = {};
  if (node.properties && typeof node.properties === "object") {
    for (const [key, child] of Object.entries(node.properties as Record<string, unknown>)) {
      const converted = jsonSchemaToTypeBox(child);
      properties[key] = required.has(key) ? converted : Type.Optional(converted);
    }
  }
  // Required keys without a property definition still have to be present.
  for (const key of required) {
    if (!(key in properties)) properties[key] = Type.Unknown();
  }

  const options: Record<string, unknown> = {};
  if (node.additionalProperties === false) {
    options.additionalProperties = false;
  } else if (node.additionalProperties && typeof node.additionalProperties === "object") {
    options.additionalProperties = jsonSchemaToTypeBox(node.additionalProperties);
  }
  return Type.Object(properties, options);
}

/**
 * Converts a plain JSON Schema document into an equivalent TypeBox schema.
 *
 * A schema that already is a TypeBox schema is returned unchanged.
 *
 * @param schema - The JSON Schema document (or boolean schema)
 * @returns A TypeBox schema usable with `Value.Check` / `Value.Errors`
 */
export function jsonSchemaToTypeBox(schema: unknown): TSchema {
  if (schema === true || schema === undefined || schema === null) return Type.Unknown();
  if (schema === false) return Type.Never();
  if (typeof schema !== "object" || Array.isArray(schema)) return Type.Unknown();
  if (Kind in schema) return schema as TSchema;

  const node = schema as JsonSchemaNode;

  if (node.const !== undefined) return literal(node.const);
  if (Array.isArray(node.enum)) {
    const members = node.enum.map(literal);
    return members.length === 1 ? members[0]! : Type.Union(members);
  }
  if (Array.isArray(node.anyOf)) return Type.Union(node.anyOf.map(jsonSchemaToTypeBox));
  if (Array.isArray(node.oneOf)) return Type.Union(node.oneOf.map(jsonSchemaToTypeBox));
  if (Array.isArray(node.allOf)) return Type.Intersect(node.allOf.map(jsonSchemaToTypeBox));

  if (Array.isArray(node.type)) {
    return Type.Union((node.type as unknown[]).map((t) => convertTyped(node, String(t))));
  }
  if (typeof node.type === "string") return convertTyped(node, node.type);
  if (node.properties !== undefined || node.required !== undefined) return convertObject(node);

  return Type.Unknown();
}

/**
 * Validates a value against a plain JSON Schema document.
 *
 * @param schema - The JSON Schema document
 * @param value - The value to validate
 * @returns `{ valid: true }`, or the list of validation errors
 */
export function validateJsonSchema(schema: unknown, value: unknown): JsonSchemaValidationResult {
  const compiled = jsonSchemaToTypeBox(schema);
  if (Value.Check(compiled, value)) return { valid: true };
  return {
    valid: false,
    errors: [...Value.Errors(compiled, value)].map((e) => ({ path: e.path, message: e.message })),
  };
}
