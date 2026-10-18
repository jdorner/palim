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

/** Groups of template functions, in display order. */
export const TEMPLATE_FUNCTION_CATEGORIES = ["math", "string", "list", "logic", "encoding", "date"] as const;

/** A template function group (shown as a section in the variable picker). */
export type TemplateFunctionCategory = (typeof TEMPLATE_FUNCTION_CATEGORIES)[number];

/**
 * Describes one built-in template function for author-facing tooling.
 */
export interface TemplateFunctionMeta {
  /** The name authors call in expressions (e.g. `stripDataUri`). */
  name: string;
  /** The group the function is listed under. */
  category: TemplateFunctionCategory;
  /** A human-readable signature, e.g. `stripDataUri(value)`. */
  signature: string;
  /** A concise one-line description of what the function does. */
  description: string;
  /** The function's return type as a short label, e.g. `string`. */
  returnType: string;
}

/**
 * Metadata for every built-in template function, grouped by category in
 * display order.
 *
 * The backend runtime registry validates that its implemented functions match
 * these names exactly (see `templateFunctions/index.ts`), so this list stays in
 * sync with what the evaluator actually accepts.
 */
export const TEMPLATE_FUNCTION_META: readonly TemplateFunctionMeta[] = [
  {
    name: "num",
    category: "math",
    signature: "num(value)",
    description: "Convert a value to a number, so arithmetic on text values adds instead of concatenating.",
    returnType: "number",
  },
  {
    name: "int",
    category: "math",
    signature: "int(value)",
    description: "Convert a value to an integer (truncated toward zero).",
    returnType: "number",
  },
  {
    name: "round",
    category: "math",
    signature: "round(value, digits?)",
    description: "Round half away from zero to a number of decimal places (default 0).",
    returnType: "number",
  },
  {
    name: "floor",
    category: "math",
    signature: "floor(value)",
    description: "Round down to the next integer.",
    returnType: "number",
  },
  {
    name: "ceil",
    category: "math",
    signature: "ceil(value)",
    description: "Round up to the next integer.",
    returnType: "number",
  },
  {
    name: "abs",
    category: "math",
    signature: "abs(value)",
    description: "Absolute value (the number without its sign).",
    returnType: "number",
  },
  {
    name: "min",
    category: "math",
    signature: "min(a, b, ... | list)",
    description: "The smallest of several numbers or of a list.",
    returnType: "number",
  },
  {
    name: "max",
    category: "math",
    signature: "max(a, b, ... | list)",
    description: "The largest of several numbers or of a list.",
    returnType: "number",
  },
  {
    name: "clamp",
    category: "math",
    signature: "clamp(value, lo, hi)",
    description: "Limit a number to the range lo..hi.",
    returnType: "number",
  },
  {
    name: "formatNumber",
    category: "math",
    signature: "formatNumber(value, digits?, locale?)",
    description: "Format a number with grouping separators (default locale de-DE).",
    returnType: "string",
  },
  {
    name: "trim",
    category: "string",
    signature: "trim(value)",
    description: "Trim leading and trailing whitespace from a value.",
    returnType: "string",
  },
  {
    name: "upper",
    category: "string",
    signature: "upper(value)",
    description: "Convert to upper case.",
    returnType: "string",
  },
  {
    name: "lower",
    category: "string",
    signature: "lower(value)",
    description: "Convert to lower case.",
    returnType: "string",
  },
  {
    name: "capitalize",
    category: "string",
    signature: "capitalize(value)",
    description: "Upper-case the first character.",
    returnType: "string",
  },
  {
    name: "length",
    category: "string",
    signature: "length(value)",
    description: "Length of a text or number of elements of a list.",
    returnType: "number",
  },
  {
    name: "substring",
    category: "string",
    signature: "substring(value, start, end?)",
    description: "Part of a text by position (negative positions count from the end).",
    returnType: "string",
  },
  {
    name: "replace",
    category: "string",
    signature: "replace(value, search, replacement)",
    description: "Replace every occurrence of a text (plain text, not a pattern).",
    returnType: "string",
  },
  {
    name: "split",
    category: "string",
    signature: "split(value, separator)",
    description: "Split a text into a list at a separator.",
    returnType: "list",
  },
  {
    name: "join",
    category: "string",
    signature: "join(list, separator?)",
    description: 'Join a list into a text (default separator ", ").',
    returnType: "string",
  },
  {
    name: "padStart",
    category: "string",
    signature: "padStart(value, length, fill?)",
    description: 'Pad a text at the start to a minimum length, e.g. padStart(7, 3, "0") gives 007.',
    returnType: "string",
  },
  {
    name: "padEnd",
    category: "string",
    signature: "padEnd(value, length, fill?)",
    description: "Pad a text at the end to a minimum length.",
    returnType: "string",
  },
  {
    name: "contains",
    category: "string",
    signature: "contains(value, search)",
    description: "Whether a text contains a part, or a list contains an element.",
    returnType: "boolean",
  },
  {
    name: "startsWith",
    category: "string",
    signature: "startsWith(value, prefix)",
    description: "Whether a text starts with a prefix.",
    returnType: "boolean",
  },
  {
    name: "endsWith",
    category: "string",
    signature: "endsWith(value, suffix)",
    description: "Whether a text ends with a suffix.",
    returnType: "boolean",
  },
  {
    name: "truncate",
    category: "string",
    signature: "truncate(value, length, suffix?)",
    description: 'Shorten a text to a maximum length, ending with "…" when cut.',
    returnType: "string",
  },
  {
    name: "before",
    category: "string",
    signature: "before(value, delimiter)",
    description: "Return the substring before the first occurrence of a delimiter (whole string when not found).",
    returnType: "string",
  },
  {
    name: "after",
    category: "string",
    signature: "after(value, delimiter)",
    description: "Return the substring after the first occurrence of a delimiter (empty string when not found).",
    returnType: "string",
  },
  {
    name: "beforeLast",
    category: "string",
    signature: "beforeLast(value, delimiter)",
    description: "Text before the last occurrence of a delimiter (whole string when not found).",
    returnType: "string",
  },
  {
    name: "afterLast",
    category: "string",
    signature: "afterLast(value, delimiter)",
    description: "Text after the last occurrence of a delimiter (empty string when not found).",
    returnType: "string",
  },
  {
    name: "first",
    category: "list",
    signature: "first(list)",
    description: "The first element of a list (null when empty).",
    returnType: "any",
  },
  {
    name: "last",
    category: "list",
    signature: "last(list)",
    description: "The last element of a list (null when empty).",
    returnType: "any",
  },
  {
    name: "at",
    category: "list",
    signature: "at(list, index)",
    description: "The element at a position (negative positions count from the end).",
    returnType: "any",
  },
  {
    name: "count",
    category: "list",
    signature: "count(list)",
    description: "Number of elements of a list.",
    returnType: "number",
  },
  {
    name: "sum",
    category: "list",
    signature: "sum(list, key?)",
    description: "Sum of the numbers in a list, or of a field of each element.",
    returnType: "number",
  },
  {
    name: "avg",
    category: "list",
    signature: "avg(list, key?)",
    description: "Average of the numbers in a list, or of a field of each element.",
    returnType: "number",
  },
  {
    name: "pluck",
    category: "list",
    signature: "pluck(list, key)",
    description: 'A field of every element, e.g. pluck(rows, "price").',
    returnType: "list",
  },
  {
    name: "unique",
    category: "list",
    signature: "unique(list)",
    description: "The list without duplicates.",
    returnType: "list",
  },
  {
    name: "sort",
    category: "list",
    signature: "sort(list, key?)",
    description: "A sorted copy, ascending (numbers numerically, otherwise as text).",
    returnType: "list",
  },
  {
    name: "reverse",
    category: "list",
    signature: "reverse(list)",
    description: "A reversed copy of a list.",
    returnType: "list",
  },
  {
    name: "slice",
    category: "list",
    signature: "slice(list, start, end?)",
    description: "Part of a list by position (negative positions count from the end).",
    returnType: "list",
  },
  {
    name: "keys",
    category: "list",
    signature: "keys(object)",
    description: "The field names of an object.",
    returnType: "list",
  },
  {
    name: "values",
    category: "list",
    signature: "values(object)",
    description: "The field values of an object.",
    returnType: "list",
  },
  {
    name: "range",
    category: "list",
    signature: "range(count) | range(start, end)",
    description: "A list of consecutive integers (at most 10000).",
    returnType: "list",
  },
  {
    name: "if",
    category: "logic",
    signature: "if(condition, then, else?)",
    description:
      "Pick a value by a condition. Both values are evaluated; use a ? b : c to guard against missing values.",
    returnType: "any",
  },
  {
    name: "choose",
    category: "logic",
    signature: "choose(value, case1, result1, ..., fallback?)",
    description: "Map a value to a result by cases, like switch.",
    returnType: "any",
  },
  {
    name: "isEmpty",
    category: "logic",
    signature: "isEmpty(value)",
    description: 'Whether a value is null, missing, "", an empty list, or an empty object.',
    returnType: "boolean",
  },
  {
    name: "isNumber",
    category: "logic",
    signature: "isNumber(value)",
    description: "Whether a value is a number or numeric text.",
    returnType: "boolean",
  },
  {
    name: "between",
    category: "logic",
    signature: "between(value, lo, hi)",
    description: "Whether a number lies within lo..hi, bounds included.",
    returnType: "boolean",
  },
  {
    name: "toJson",
    category: "encoding",
    signature: "toJson(value, indent?)",
    description: "Serialize a value as JSON.",
    returnType: "string",
  },
  {
    name: "parseJson",
    category: "encoding",
    signature: "parseJson(text)",
    description: "Parse JSON text into a value (null when invalid).",
    returnType: "any",
  },
  {
    name: "jsonEscape",
    category: "encoding",
    signature: "jsonEscape(value)",
    description: "Escape a value so it is safe to embed inside a JSON string literal (no surrounding quotes).",
    returnType: "string",
  },
  {
    name: "base64Encode",
    category: "encoding",
    signature: "base64Encode(value)",
    description: "Encode a UTF-8 string to its base64 form.",
    returnType: "string",
  },
  {
    name: "base64Decode",
    category: "encoding",
    signature: "base64Decode(value)",
    description: "Decode a base64 string to its UTF-8 text form.",
    returnType: "string",
  },
  {
    name: "stripDataUri",
    category: "encoding",
    signature: "stripDataUri(value)",
    description: "Remove a leading data URI prefix (data:<mediatype>;base64,), yielding the raw base64 payload.",
    returnType: "string",
  },
  {
    name: "urlEncode",
    category: "encoding",
    signature: "urlEncode(value)",
    description: "Percent-encode a text for use in a URL.",
    returnType: "string",
  },
  {
    name: "urlDecode",
    category: "encoding",
    signature: "urlDecode(value)",
    description: "Decode a percent-encoded URL component.",
    returnType: "string",
  },
  {
    name: "nowIso",
    category: "date",
    signature: "nowIso()",
    description: "Return the current time as an ISO 8601 string.",
    returnType: "string",
  },
];

/**
 * The valid built-in template function names, derived from the metadata table.
 *
 * This is the canonical name allowlist consumed by the runtime registry and the
 * load-time validator, so all three (evaluator, validator, editor) agree.
 */
export const TEMPLATE_FUNCTION_NAME_LIST: readonly string[] = TEMPLATE_FUNCTION_META.map((meta) => meta.name);
