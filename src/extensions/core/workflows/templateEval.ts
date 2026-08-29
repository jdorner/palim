/**
 * Safe expression evaluation for workflow templates.
 *
 * Wraps the `subscript` expression evaluator (justin preset) to evaluate a
 * single `{{...}}` expression against a restricted scope. This module owns the
 * sandbox: subscript's built-in access guard is known to be bypassable at the
 * pinned version (a bare `constructor` identifier climbs the prototype chain
 * and the member-call path skips the guard, allowing
 * `constructor.constructor("return process")()` to reach the host `process`).
 * We therefore do NOT rely on subscript's guard and enforce isolation ourselves
 * with three independent, defense-in-depth measures:
 *
 * 1. Null-prototype scope: the scope object is built with `Object.create(null)`
 *    and populated only with whitelisted namespaces and registered functions,
 *    so a bare `constructor`/`__proto__` lookup resolves to `undefined` rather
 *    than reaching `Object`/`Function`.
 * 2. Identifier/member denylist: expressions referencing a forbidden key
 *    (`constructor`, `prototype`, `__proto__`, or any `__*__` dunder) are
 *    rejected before evaluation and treated as unresolved.
 * 3. Guarded values (secret/env) are resolved by the caller BEFORE evaluation
 *    and are never placed in the scope, so they are unreachable here.
 */

import justin from "subscript/justin";
import { TEMPLATE_FUNCTIONS } from "./templateFunctions";

/**
 * Keys that must never be reachable through an expression, as they enable
 * prototype-chain / constructor escapes. Matches subscript's own `unsafe()`
 * list plus generic dunder detection.
 */
const FORBIDDEN_KEY = /(^__.*__$)|(^(constructor|prototype|__proto__)$)/;

/**
 * Whether a single property key is forbidden (prototype-chain / constructor
 * escape vector). Shared with the dot-path traversal in `template.ts` so both
 * the evaluator and the plain-path resolver reject the same keys.
 *
 * @param key - The property key to check
 * @returns True when the key must not be accessed
 */
export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEY.test(key);
}

/**
 * Detects whether an expression string references any forbidden key as an
 * identifier or member. This is a conservative lexical check: it tokenizes
 * identifier-like words (including a leading `.` to catch member access) and
 * flags any that match {@link FORBIDDEN_KEY}. Because forbidden keys are never
 * legitimate in a workflow template, false positives are acceptable and safe
 * (the expression is simply left literal).
 *
 * @param expr - The raw expression text (without the surrounding braces)
 * @returns True when the expression references a forbidden key
 */
export function referencesForbiddenKey(expr: string): boolean {
  // Match bare identifiers and quoted/bracketed member keys.
  const idPattern = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  for (let m = idPattern.exec(expr); m !== null; m = idPattern.exec(expr)) {
    if (FORBIDDEN_KEY.test(m[0])) return true;
  }
  // Also catch string-literal member keys like ["constructor"] or ['__proto__'].
  const strKeyPattern = /["'`]\s*(__.*?__|constructor|prototype)\s*["'`]/;
  return strKeyPattern.test(expr);
}

/**
 * Builds the null-prototype evaluation scope from a set of whitelisted,
 * non-sensitive namespace values plus the registered built-in functions.
 *
 * The returned object has no prototype, so property lookups for keys not
 * explicitly set (e.g. `constructor`, `toString`) resolve to `undefined`
 * instead of climbing to `Object.prototype`.
 *
 * @param namespaces - Whitelisted scope entries (e.g. trigger, steps, item)
 * @returns A prototype-less scope object safe to hand to the evaluator
 */
export function buildEvalScope(namespaces: Record<string, unknown>): Record<string, unknown> {
  const scope: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(namespaces)) {
    scope[key] = value;
  }
  for (const [name, fn] of Object.entries(TEMPLATE_FUNCTIONS)) {
    scope[name] = fn;
  }
  return scope;
}

/** Result of a safe expression evaluation. */
export interface EvalResult {
  /** True when the expression was evaluated to a value. */
  ok: boolean;
  /** The evaluated value (only meaningful when `ok` is true). */
  value?: unknown;
  /** A warning describing why evaluation failed (only when `ok` is false). */
  warning?: string;
}

/**
 * Safely evaluate a single template expression against the given namespaces.
 *
 * Enforces the sandbox: rejects forbidden-key references, evaluates against a
 * null-prototype scope, and never throws - a parse or runtime failure is
 * reported as `{ ok: false, warning }` so the caller can leave the expression
 * literal.
 *
 * @param expr - The expression text (without surrounding braces)
 * @param namespaces - Whitelisted, non-sensitive scope values
 * @returns An {@link EvalResult}
 */
export function evaluateExpression(expr: string, namespaces: Record<string, unknown>): EvalResult {
  if (referencesForbiddenKey(expr)) {
    return { ok: false, warning: `Forbidden key reference in template expression: ${expr}` };
  }

  const scope = buildEvalScope(namespaces);

  try {
    const compiled = justin(expr);
    const value = compiled(scope);
    return { ok: true, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, warning: `Failed to evaluate template expression "${expr}": ${message}` };
  }
}
