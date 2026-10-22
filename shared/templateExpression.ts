/**
 * Classification of `{{...}}` template expression bodies, shared by the
 * backend resolver, the load-time validator, and the frontend editor.
 *
 * A body is either a plain dot-path (`steps.fetch-mails.result.id`), resolved
 * by the namespace branches, or an expression (`steps.a.result.n + 1`,
 * `trim(x)`), handed to the sandboxed evaluator. Hyphens count as path
 * characters, so `a-b` stays a path (hyphenated slugs and keys keep working);
 * subtraction needs whitespace or other non-path characters: `a - b`.
 *
 * @module
 */

/** Matches a body made only of path characters (identifier chars, `.`, `-`). */
const PLAIN_PATH = /^[A-Za-z0-9_$.-]+$/;

/**
 * Whether a trimmed expression body is a plain dot-path rather than an
 * expression for the evaluator.
 *
 * @param trimmed - The trimmed expression body (without braces)
 * @returns True when the body is a plain path
 */
export function isPlainPath(trimmed: string): boolean {
  return PLAIN_PATH.test(trimmed);
}

/** Matches string literals (single, double, backtick quoted). */
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/**
 * Replaces string literals with spaces of the same length, so lexical scans
 * of an expression do not match text inside quotes and offsets stay valid.
 *
 * @param expr - The expression body
 * @returns The expression with string literals blanked out
 */
export function maskStringLiterals(expr: string): string {
  return expr.replace(STRING_LITERAL, (m) => " ".repeat(m.length));
}

/** Matches a bitwise operator: a shift, `^`, `~`, or a single (not doubled) `|` / `&`. */
const BITWISE_OPERATOR = /<<|>>>?|\^|~|(?<![|&])[|&](?![|&])/;

/**
 * Finds a bitwise operator (`|`, `&`, `^`, `~`, `<<`, `>>`, `>>>`) outside
 * string literals. Templates have no use for them, and they are easy to hit by
 * mistake: `steps.a.result.list | join(", ")` (filter syntax from other
 * template languages) evaluates as a bitwise OR and silently yields `0`.
 *
 * @param expr - The expression body (without braces)
 * @returns The first bitwise operator found, or null when there is none
 */
export function findBitwiseOperator(expr: string): string | null {
  return BITWISE_OPERATOR.exec(maskStringLiterals(expr))?.[0] ?? null;
}

/**
 * Explains why a bitwise operator is rejected, with the function-call form to
 * use instead of pipe/filter syntax.
 *
 * @param operator - The operator returned by {@link findBitwiseOperator}
 * @returns A sentence for warnings and validation messages
 */
export function bitwiseOperatorHint(operator: string): string {
  return operator === "|"
    ? `"|" is a bitwise OR, not a filter: templates have no pipe syntax. Call the function instead, e.g. join(list, ", ")`
    : `the bitwise operator "${operator}" is not supported in templates`;
}
