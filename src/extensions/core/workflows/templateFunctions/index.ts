/**
 * Built-in functions callable from workflow template expressions.
 *
 * These are pure, deterministic, side-effect-free helpers exposed to the
 * expression evaluator (see {@link ../templateEval}). They perform text, math,
 * list, logic, encoding, and date transformations only - never I/O, network,
 * filesystem, or any environment/secret access. The registry is the single
 * source of truth for which function names are valid, shared by the runtime
 * evaluator and the load-time validator (`dagTemplateValidation.ts`) so the two
 * cannot diverge.
 *
 * Every function is total: it never throws, but coerces its inputs (see
 * `coerce.ts`) and returns an empty or `NaN` result for unusable ones. Property
 * reads on data go through `ownProp`, so a data-supplied key can never reach
 * inherited host objects such as `constructor`.
 *
 * The set of valid names is derived from the shared, pure metadata table
 * ({@link ../../../../../shared/templateFunctionMeta}) so the evaluator, the
 * load-time validator, and the editor autocomplete all agree on which functions
 * exist. This module asserts at load time that the implemented functions match
 * that table exactly (no drift in either direction).
 */

import { TEMPLATE_FUNCTION_NAME_LIST } from "../../../../../shared/templateFunctionMeta";
import { currentClock, nowIso, setClock } from "./date";
import {
  base64Decode,
  base64Encode,
  jsonEscape,
  parseJson,
  stripDataUri,
  toJson,
  urlDecode,
  urlEncode,
} from "./encoding";
import { at, avg, count, first, keys, last, pluck, range, reverse, slice, sort, sum, unique, values } from "./list";
import { between, choose, ifFn, isEmpty, isNumber } from "./logic";
import { abs, ceil, clamp, floor, formatNumber, int, max, min, num, round } from "./math";
import {
  after,
  afterLast,
  before,
  beforeLast,
  capitalize,
  contains,
  endsWith,
  join,
  length,
  lower,
  padEnd,
  padStart,
  replace,
  split,
  startsWith,
  substring,
  trim,
  truncate,
  upper,
} from "./string";

export * from "./encoding";
export * from "./list";
export * from "./logic";
export * from "./math";
export * from "./string";
export { currentClock, nowIso, setClock };

/**
 * The registry of built-in template functions, keyed by the name authors call
 * in expressions. This object is the single source of truth for valid function
 * names; the validator imports {@link TEMPLATE_FUNCTION_NAMES} to accept them.
 *
 * Note: this is a plain object literal (with an `Object` prototype). It is NOT
 * used directly as the evaluation scope - the evaluator copies these entries
 * into a null-prototype scope so that prototype-chain lookups cannot reach host
 * objects. See {@link ../templateEval}.
 */
export const TEMPLATE_FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
  // math
  num,
  int,
  round,
  floor,
  ceil,
  abs,
  min,
  max,
  clamp,
  formatNumber,
  // string
  trim,
  upper,
  lower,
  capitalize,
  length,
  substring,
  replace,
  split,
  join,
  padStart,
  padEnd,
  contains,
  startsWith,
  endsWith,
  truncate,
  before,
  after,
  beforeLast,
  afterLast,
  // list
  first,
  last,
  at,
  count,
  sum,
  avg,
  pluck,
  unique,
  sort,
  reverse,
  slice,
  keys,
  values,
  range,
  // logic (`if` is a reserved word in TypeScript, so the implementation is `ifFn`)
  if: ifFn,
  choose,
  isEmpty,
  isNumber,
  between,
  // json & encoding
  toJson,
  parseJson,
  jsonEscape,
  base64Encode,
  base64Decode,
  stripDataUri,
  urlEncode,
  urlDecode,
  // date
  nowIso,
};

/**
 * The set of valid built-in template function names.
 *
 * Derived from the shared metadata table ({@link TEMPLATE_FUNCTION_NAME_LIST})
 * rather than from `Object.keys(TEMPLATE_FUNCTIONS)`, so the runtime, the
 * validator, and the editor all read the same source. The load-time assertion
 * below guarantees the implemented functions and the metadata table describe
 * exactly the same set of names.
 */
export const TEMPLATE_FUNCTION_NAMES: ReadonlySet<string> = new Set(TEMPLATE_FUNCTION_NAME_LIST);

/**
 * Fail fast if the implemented functions and the shared metadata table drift
 * apart. Either a function is registered without metadata, or metadata names a
 * function that is not implemented - both are programming errors.
 */
{
  const implemented = Object.keys(TEMPLATE_FUNCTIONS).sort();
  const declared = [...TEMPLATE_FUNCTION_NAME_LIST].sort();
  const missingMeta = implemented.filter((name) => !TEMPLATE_FUNCTION_NAMES.has(name));
  const missingImpl = declared.filter((name) => !(name in TEMPLATE_FUNCTIONS));
  if (missingMeta.length > 0 || missingImpl.length > 0) {
    throw new Error(
      `Template function registry drift: functions without metadata [${missingMeta.join(", ")}], ` +
        `metadata without implementation [${missingImpl.join(", ")}]`,
    );
  }
}
