/**
 * Author-facing metadata for the built-in workflow template functions.
 *
 * This module is the single shared source of truth for WHICH function names are
 * valid inside `{{...}}` expressions and for the human-readable documentation
 * shown by editor assistance (autocomplete labels, signatures, descriptions).
 *
 * It is intentionally a pure data module with no backend-only imports, so it is
 * import-safe from both the backend runtime (`src/extensions/core/workflows/`)
 * and the frontend build (`frontend/`). The backend runtime registry
 * (`TEMPLATE_FUNCTIONS`) derives its valid-name set from this table so the
 * evaluator, the load-time validator, and the editor cannot drift apart: adding
 * a function here (and wiring its implementation) makes it appear in editor
 * assistance automatically.
 *
 * @module
 */

/**
 * Describes one built-in template function for author-facing tooling.
 */
export interface TemplateFunctionMeta {
  /** The name authors call in expressions (e.g. `stripDataUri`). */
  name: string;
  /** A human-readable signature, e.g. `stripDataUri(value)`. */
  signature: string;
  /** A concise one-line description of what the function does. */
  description: string;
  /** The function's return type as a short label, e.g. `string`. */
  returnType: string;
}

/**
 * Metadata for every built-in template function, in a stable declaration order.
 *
 * The backend runtime registry validates that its implemented functions match
 * these names exactly (see `templateFunctions.ts`), so this list stays in sync
 * with what the evaluator actually accepts.
 */
export const TEMPLATE_FUNCTION_META: readonly TemplateFunctionMeta[] = [
  {
    name: "stripDataUri",
    signature: "stripDataUri(value)",
    description: "Remove a leading data URI prefix (data:<mediatype>;base64,), yielding the raw base64 payload.",
    returnType: "string",
  },
  {
    name: "base64Decode",
    signature: "base64Decode(value)",
    description: "Decode a base64 string to its UTF-8 text form.",
    returnType: "string",
  },
  {
    name: "jsonEscape",
    signature: "jsonEscape(value)",
    description: "Escape a value so it is safe to embed inside a JSON string literal (no surrounding quotes).",
    returnType: "string",
  },
  {
    name: "after",
    signature: "after(value, delimiter)",
    description: "Return the substring after the first occurrence of a delimiter (empty string when not found).",
    returnType: "string",
  },
  {
    name: "before",
    signature: "before(value, delimiter)",
    description: "Return the substring before the first occurrence of a delimiter (whole string when not found).",
    returnType: "string",
  },
  {
    name: "trim",
    signature: "trim(value)",
    description: "Trim leading and trailing whitespace from a value.",
    returnType: "string",
  },
  {
    name: "nowIso",
    signature: "nowIso()",
    description: "Return the current time as an ISO 8601 string.",
    returnType: "string",
  },
] as const;

/**
 * The valid built-in template function names, derived from the metadata table.
 *
 * This is the canonical name allowlist consumed by the runtime registry and the
 * load-time validator, so all three (evaluator, validator, editor) agree.
 */
export const TEMPLATE_FUNCTION_NAME_LIST: readonly string[] = TEMPLATE_FUNCTION_META.map((meta) => meta.name);
