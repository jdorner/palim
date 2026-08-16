/**
 * Workflow condition evaluator.
 *
 * Pure function that evaluates a structured condition against a resolved value.
 * Used by `if` and `case` control flow nodes to determine branch execution.
 *
 * No I/O, deterministic output for identical input.
 */

/** Supported comparison operators for conditions. */
export type ConditionOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains" | "exists" | "matches";

/**
 * A structured condition object with a `ref` field and exactly one operator field.
 *
 * The `ref` field contains a template expression that resolves to the value
 * being tested. Exactly one operator field must be present.
 */
export interface Condition {
  /** Template expression that resolves to the value to test. */
  ref: string;
  /** Strict equality after String() coercion. */
  eq?: unknown;
  /** Logical negation of eq. */
  neq?: unknown;
  /** Greater than (numeric if both parseable, otherwise lexicographic). */
  gt?: unknown;
  /** Greater than or equal (numeric if both parseable, otherwise lexicographic). */
  gte?: unknown;
  /** Less than (numeric if both parseable, otherwise lexicographic). */
  lt?: unknown;
  /** Less than or equal (numeric if both parseable, otherwise lexicographic). */
  lte?: unknown;
  /** Membership check: resolved value is in the array (String() coercion). */
  in?: unknown[];
  /** Case-sensitive substring check. */
  contains?: unknown;
  /** Truthiness check: not null, not undefined, not empty string. */
  exists?: boolean;
  /** Regular expression test against String(resolvedValue). */
  matches?: string;
}

/** The set of all valid operator field names. */
const OPERATOR_KEYS: ReadonlySet<string> = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "contains",
  "exists",
  "matches",
]);

/**
 * Checks whether a value is parseable as a finite number via Number().
 *
 * @param value - The value to check
 * @returns true if Number(value) produces a finite number (excludes NaN, Infinity, -Infinity)
 */
function isFiniteNumber(value: unknown): boolean {
  const num = Number(value);
  return Number.isFinite(num);
}

/**
 * Extracts the single active operator and its operand from a condition object.
 * Throws if zero or multiple operators are present.
 *
 * @param condition - The condition object to inspect
 * @returns A tuple of [operator name, operand value]
 * @throws Error if zero or more than one operator field is present
 */
function extractOperator(condition: Condition): [ConditionOperator, unknown] {
  const entries: [ConditionOperator, unknown][] = [];

  for (const key of Object.keys(condition)) {
    if (OPERATOR_KEYS.has(key)) {
      entries.push([key as ConditionOperator, (condition as unknown as Record<string, unknown>)[key]]);
    }
  }

  if (entries.length === 0) {
    throw new Error("Condition must contain exactly one operator, but none was provided");
  }

  if (entries.length > 1) {
    const ops = entries.map(([k]) => k).join(", ");
    throw new Error(`Condition must contain exactly one operator, but found ${entries.length}: ${ops}`);
  }

  // Safe: entries.length is exactly 1 after the checks above
  return entries[0] as [ConditionOperator, unknown];
}

/**
 * Evaluates a condition against a resolved value.
 *
 * Pure function - no I/O, deterministic, throws on invalid input.
 *
 * @param resolvedValue - The value resolved from the condition's ref template
 * @param condition - The condition object with exactly one operator
 * @returns Boolean result of the evaluation
 * @throws Error if condition has zero or multiple operators, or if `matches` operand is an invalid regex
 */
export function evaluateCondition(resolvedValue: unknown, condition: Condition): boolean {
  const [operator, operand] = extractOperator(condition);

  // Null/undefined short-circuit: return false for all operators except `exists`
  if ((resolvedValue === null || resolvedValue === undefined) && operator !== "exists") {
    return false;
  }

  switch (operator) {
    case "eq":
      return String(resolvedValue) === String(operand);

    case "neq":
      return String(resolvedValue) !== String(operand);

    case "gt":
      if (isFiniteNumber(resolvedValue) && isFiniteNumber(operand)) {
        return Number(resolvedValue) > Number(operand);
      }
      return String(resolvedValue) > String(operand);

    case "gte":
      if (isFiniteNumber(resolvedValue) && isFiniteNumber(operand)) {
        return Number(resolvedValue) >= Number(operand);
      }
      return String(resolvedValue) >= String(operand);

    case "lt":
      if (isFiniteNumber(resolvedValue) && isFiniteNumber(operand)) {
        return Number(resolvedValue) < Number(operand);
      }
      return String(resolvedValue) < String(operand);

    case "lte":
      if (isFiniteNumber(resolvedValue) && isFiniteNumber(operand)) {
        return Number(resolvedValue) <= Number(operand);
      }
      return String(resolvedValue) <= String(operand);

    case "in": {
      const arr = operand as unknown[];
      const resolved = String(resolvedValue);
      return arr.some((element) => String(element) === resolved);
    }

    case "contains":
      // Null/undefined already short-circuited above, but for explicit clarity
      if (resolvedValue === null || resolvedValue === undefined) {
        return false;
      }
      return String(resolvedValue).includes(String(operand));

    case "exists":
      return resolvedValue !== null && resolvedValue !== undefined && resolvedValue !== "";

    case "matches": {
      const pattern = operand as string;
      try {
        const regex = new RegExp(pattern);
        return regex.test(String(resolvedValue));
      } catch {
        throw new Error(`Invalid regex pattern in matches operator: ${pattern}`);
      }
    }
  }
}
