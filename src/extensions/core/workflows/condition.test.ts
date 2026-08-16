import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Condition, ConditionOperator } from "./condition";
import { evaluateCondition } from "./condition";

/** All valid operator names. */
const ALL_OPERATORS: ConditionOperator[] = [
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
];

/** Arbitrary for non-null, non-undefined primitive values (strings, numbers, booleans). */
const primitiveArb: fc.Arbitrary<string | number | boolean> = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
);

/** Arbitrary for values that are parseable as finite numbers. */
const finiteNumericArb: fc.Arbitrary<string | number> = fc.oneof(
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.integer().map((n) => String(n)),
  fc.double({ noNaN: true, noDefaultInfinity: true }).map((n) => String(n)),
);

/** Arbitrary for values that are NOT parseable as finite numbers (String coercion path). */
const nonNumericStringArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1 })
  .filter((s) => !Number.isFinite(Number(s)));

/** Arbitrary for simple, valid regex patterns that won't throw. */
const validRegexArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(".*"),
  fc.constant("^hello"),
  fc.constant("world$"),
  fc.constant("[a-z]+"),
  fc.constant("\\d+"),
  fc.constant("foo|bar"),
  fc.constant("^$"),
  fc.constant(".+"),
  fc.stringMatching(/^[a-z]{1,5}$/),
);

/** Arbitrary for invalid regex patterns that will throw. */
const invalidRegexArb: fc.Arbitrary<string> = fc.constantFrom("[invalid", "(unclosed", "*bad", "+oops", "(?P<broken");

describe("evaluateCondition", () => {
  describe("example-based tests", () => {
    test("eq: empty string equals empty string", () => {
      expect(evaluateCondition("", { ref: "x", eq: "" })).toBe(true);
    });

    test("eq: zero equals string zero", () => {
      expect(evaluateCondition(0, { ref: "x", eq: "0" })).toBe(true);
    });

    test("eq: boolean true equals string true", () => {
      expect(evaluateCondition(true, { ref: "x", eq: "true" })).toBe(true);
    });

    test("neq: different values are not equal", () => {
      expect(evaluateCondition("hello", { ref: "x", neq: "world" })).toBe(true);
    });

    test("gt: numeric comparison 10 > 9", () => {
      expect(evaluateCondition(10, { ref: "x", gt: 9 })).toBe(true);
    });

    test("gt: lexicographic fallback when not numeric", () => {
      expect(evaluateCondition("banana", { ref: "x", gt: "apple" })).toBe(true);
    });

    test("gt: string '9' > '10' lexicographically when one is non-numeric", () => {
      // "9" > "10" lexicographically but 9 < 10 numerically
      // Both are parseable as finite numbers, so numeric path is used
      expect(evaluateCondition("9", { ref: "x", gt: "10" })).toBe(false);
    });

    test("lt: numeric comparison 5 < 10", () => {
      expect(evaluateCondition(5, { ref: "x", lt: 10 })).toBe(true);
    });

    test("gte: equal values return true", () => {
      expect(evaluateCondition(5, { ref: "x", gte: 5 })).toBe(true);
    });

    test("lte: equal values return true", () => {
      expect(evaluateCondition(5, { ref: "x", lte: 5 })).toBe(true);
    });

    test("in: value found in array", () => {
      expect(evaluateCondition("b", { ref: "x", in: ["a", "b", "c"] })).toBe(true);
    });

    test("in: value not found in array", () => {
      expect(evaluateCondition("z", { ref: "x", in: ["a", "b", "c"] })).toBe(false);
    });

    test("in: numeric coercion matches", () => {
      expect(evaluateCondition(1, { ref: "x", in: ["1", "2", "3"] })).toBe(true);
    });

    test("contains: substring found", () => {
      expect(evaluateCondition("hello world", { ref: "x", contains: "world" })).toBe(true);
    });

    test("contains: substring not found", () => {
      expect(evaluateCondition("hello", { ref: "x", contains: "world" })).toBe(false);
    });

    test("contains: null input returns false", () => {
      expect(evaluateCondition(null, { ref: "x", contains: "x" })).toBe(false);
    });

    test("contains: undefined input returns false", () => {
      expect(evaluateCondition(undefined, { ref: "x", contains: "x" })).toBe(false);
    });

    test("exists: non-empty string is truthy", () => {
      expect(evaluateCondition("hello", { ref: "x", exists: true })).toBe(true);
    });

    test("exists: empty string returns false", () => {
      expect(evaluateCondition("", { ref: "x", exists: true })).toBe(false);
    });

    test("exists: null returns false", () => {
      expect(evaluateCondition(null, { ref: "x", exists: true })).toBe(false);
    });

    test("exists: undefined returns false", () => {
      expect(evaluateCondition(undefined, { ref: "x", exists: true })).toBe(false);
    });

    test("exists: zero is truthy", () => {
      expect(evaluateCondition(0, { ref: "x", exists: true })).toBe(true);
    });

    test("exists: false boolean is truthy (not null/undefined/empty)", () => {
      expect(evaluateCondition(false, { ref: "x", exists: true })).toBe(true);
    });

    test("matches: simple pattern matches", () => {
      expect(evaluateCondition("hello123", { ref: "x", matches: "\\d+" })).toBe(true);
    });

    test("matches: pattern does not match", () => {
      expect(evaluateCondition("hello", { ref: "x", matches: "^\\d+$" })).toBe(false);
    });

    test("matches: invalid regex throws", () => {
      expect(() => evaluateCondition("test", { ref: "x", matches: "[invalid" })).toThrow();
    });

    test("null short-circuits to false for eq", () => {
      expect(evaluateCondition(null, { ref: "x", eq: "anything" })).toBe(false);
    });

    test("undefined short-circuits to false for gt", () => {
      expect(evaluateCondition(undefined, { ref: "x", gt: 5 })).toBe(false);
    });

    test("throws on zero operators", () => {
      expect(() => evaluateCondition("x", { ref: "x" } as Condition)).toThrow();
    });

    test("throws on multiple operators", () => {
      expect(() => evaluateCondition("x", { ref: "x", eq: "x", neq: "y" } as Condition)).toThrow();
    });

    test("NaN as resolved value: eq uses string coercion", () => {
      expect(evaluateCondition(Number.NaN, { ref: "x", eq: "NaN" })).toBe(true);
    });

    test("Infinity as resolved value: eq uses string coercion", () => {
      expect(evaluateCondition(Number.POSITIVE_INFINITY, { ref: "x", eq: "Infinity" })).toBe(true);
    });

    test("gt: Infinity not treated as finite number, falls back to lexicographic", () => {
      // Infinity is not finite, so lexicographic comparison is used
      expect(evaluateCondition(Number.POSITIVE_INFINITY, { ref: "x", gt: "A" })).toBe(true);
    });
  });

  describe("property tests", () => {
    /**
     * **Validates: Requirements 8.3**
     *
     * Property 4: eq/neq semantics
     *
     * For any two values a and b, evaluateCondition(a, { ref: "x", eq: b })
     * returns true iff String(a) === String(b), and neq is the logical negation.
     */
    test("Property 4: eq/neq semantics - string coercion equality and negation", () => {
      fc.assert(
        fc.property(primitiveArb, primitiveArb, (a, b) => {
          const eqResult = evaluateCondition(a, { ref: "x", eq: b });
          const neqResult = evaluateCondition(a, { ref: "x", neq: b });

          const expected = String(a) === String(b);
          expect(eqResult).toBe(expected);
          expect(neqResult).toBe(!expected);
        }),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 8.2**
     *
     * Property 5: Numeric comparison with coercion
     *
     * For any two values that are both parseable as finite numbers,
     * gt/gte/lt/lte use numeric comparison. When either is not finite,
     * falls back to lexicographic string comparison.
     */
    test("Property 5: Numeric comparison with coercion - numeric path", () => {
      fc.assert(
        fc.property(finiteNumericArb, finiteNumericArb, (a, b) => {
          const numA = Number(a);
          const numB = Number(b);

          expect(evaluateCondition(a, { ref: "x", gt: b })).toBe(numA > numB);
          expect(evaluateCondition(a, { ref: "x", gte: b })).toBe(numA >= numB);
          expect(evaluateCondition(a, { ref: "x", lt: b })).toBe(numA < numB);
          expect(evaluateCondition(a, { ref: "x", lte: b })).toBe(numA <= numB);
        }),
        { numRuns: 100 },
      );
    });

    test("Property 5: Numeric comparison with coercion - lexicographic fallback", () => {
      fc.assert(
        fc.property(nonNumericStringArb, nonNumericStringArb, (a, b) => {
          const strA = String(a);
          const strB = String(b);

          expect(evaluateCondition(a, { ref: "x", gt: b })).toBe(strA > strB);
          expect(evaluateCondition(a, { ref: "x", gte: b })).toBe(strA >= strB);
          expect(evaluateCondition(a, { ref: "x", lt: b })).toBe(strA < strB);
          expect(evaluateCondition(a, { ref: "x", lte: b })).toBe(strA <= strB);
        }),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 8.4**
     *
     * Property 6: `in` operator membership
     *
     * For any value v and array arr, `in` returns true iff there exists
     * at least one element e in arr such that String(v) === String(e).
     */
    test("Property 6: `in` operator membership - string-coerced membership check", () => {
      fc.assert(
        fc.property(primitiveArb, fc.array(primitiveArb, { minLength: 0, maxLength: 20 }), (v, arr) => {
          const result = evaluateCondition(v, { ref: "x", in: arr });
          const expected = arr.some((e) => String(v) === String(e));

          expect(result).toBe(expected);
        }),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 8.5**
     *
     * Property 7: `contains` operator
     *
     * For any two non-null, non-undefined values a and b, contains returns
     * true iff String(a).includes(String(b)). For null/undefined input,
     * returns false.
     */
    test("Property 7: `contains` operator - substring check", () => {
      fc.assert(
        fc.property(primitiveArb, primitiveArb, (a, b) => {
          const result = evaluateCondition(a, { ref: "x", contains: b });
          const expected = String(a).includes(String(b));

          expect(result).toBe(expected);
        }),
        { numRuns: 100 },
      );
    });

    test("Property 7: `contains` operator - null/undefined returns false", () => {
      fc.assert(
        fc.property(primitiveArb, (operand) => {
          expect(evaluateCondition(null, { ref: "x", contains: operand })).toBe(false);
          expect(evaluateCondition(undefined, { ref: "x", contains: operand })).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 8.6**
     *
     * Property 8: `exists` operator
     *
     * For any value v, exists returns true iff v is not null,
     * not undefined, and not empty string "".
     */
    test("Property 8: `exists` operator - not null, not undefined, not empty string", () => {
      const anyValueArb: fc.Arbitrary<unknown> = fc.oneof(
        primitiveArb,
        fc.constant(null),
        fc.constant(undefined),
        fc.constant(""),
      );

      fc.assert(
        fc.property(anyValueArb, (v) => {
          const result = evaluateCondition(v, { ref: "x", exists: true });
          const expected = v !== null && v !== undefined && v !== "";

          expect(result).toBe(expected);
        }),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 8.7**
     *
     * Property 9: `matches` operator
     *
     * For any value v and valid regex pattern, matches returns true iff
     * new RegExp(pattern).test(String(v)). For invalid regex, throws.
     */
    test("Property 9: `matches` operator - regex test with valid patterns", () => {
      fc.assert(
        fc.property(primitiveArb, validRegexArb, (v, pattern) => {
          const result = evaluateCondition(v, { ref: "x", matches: pattern });
          const expected = new RegExp(pattern).test(String(v));

          expect(result).toBe(expected);
        }),
        { numRuns: 100 },
      );
    });

    test("Property 9: `matches` operator - throws on invalid regex", () => {
      fc.assert(
        fc.property(primitiveArb, invalidRegexArb, (v, pattern) => {
          expect(() => evaluateCondition(v, { ref: "x", matches: pattern })).toThrow(
            /Invalid regex pattern in matches operator/,
          );
        }),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 8.8**
     *
     * Property 10: Null/undefined short-circuit
     *
     * For any operator other than exists, evaluateCondition(null, condition)
     * and evaluateCondition(undefined, condition) return false.
     */
    test("Property 10: Null/undefined short-circuit - returns false for non-exists operators", () => {
      const nonExistsOperatorArb = fc.constantFrom(...ALL_OPERATORS.filter((op) => op !== "exists"));

      const operandArb = fc.oneof(primitiveArb, fc.constant("test"), fc.constant(42));

      fc.assert(
        fc.property(
          fc.constantFrom(null, undefined),
          nonExistsOperatorArb,
          operandArb,
          (nullish, operator, operand) => {
            let condition: Condition;
            if (operator === "in") {
              condition = { ref: "x", in: [operand] };
            } else if (operator === "matches") {
              condition = { ref: "x", matches: ".*" };
            } else {
              condition = { ref: "x", [operator]: operand } as Condition;
            }

            expect(evaluateCondition(nullish, condition)).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 8.9**
     *
     * Property 11: Rejects multiple operators
     *
     * For any condition with two or more operator fields,
     * evaluateCondition() throws an error.
     */
    test("Property 11: Rejects multiple operators - throws error", () => {
      /** Pick 2 distinct operators from the set. */
      const twoOperatorsArb = fc.shuffledSubarray(ALL_OPERATORS, { minLength: 2, maxLength: 2 }).map(([op1, op2]) => {
        const condition: Record<string, unknown> = { ref: "x" };
        // Assign appropriate operand values for each operator type
        for (const op of [op1, op2]) {
          if (op === "in") {
            condition[op as string] = ["a", "b"];
          } else if (op === "exists") {
            condition[op as string] = true;
          } else if (op === "matches") {
            condition[op as string] = ".*";
          } else {
            condition[op as string] = "test";
          }
        }
        return condition as unknown as Condition;
      });

      fc.assert(
        fc.property(twoOperatorsArb, (condition) => {
          expect(() => evaluateCondition("test", condition)).toThrow(/exactly one operator/);
        }),
        { numRuns: 100 },
      );
    });
  });
});
