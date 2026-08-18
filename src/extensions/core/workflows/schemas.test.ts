import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import fc from "fast-check";
import {
  CaseStepSchema,
  ConditionSchema,
  EmitStepSchema,
  IfStepSchema,
  StepSchema,
  validateGlobalSlugUniqueness,
  WaitForStepSchema,
  type WorkflowStep,
} from "./schemas";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Valid slug: starts with lowercase letter, followed by lowercase alphanumeric or hyphens. */
const validSlugArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/).filter((s) => s.length >= 1);

/** Valid event name: starts with lowercase letter, followed by lowercase alphanumeric, dots, hyphens, or underscores. */
const validEventArb = fc.stringMatching(/^[a-z][a-z0-9._-]{0,30}$/).filter((s) => s.length >= 1 && s.length <= 128);

/** Arbitrary for a valid condition with exactly one operator. */
const validConditionArb = fc.oneof(
  fc.record({ ref: fc.string({ minLength: 1 }), eq: fc.jsonValue() }),
  fc.record({ ref: fc.string({ minLength: 1 }), neq: fc.jsonValue() }),
  fc.record({ ref: fc.string({ minLength: 1 }), gt: fc.jsonValue() }),
  fc.record({ ref: fc.string({ minLength: 1 }), gte: fc.jsonValue() }),
  fc.record({ ref: fc.string({ minLength: 1 }), lt: fc.jsonValue() }),
  fc.record({ ref: fc.string({ minLength: 1 }), lte: fc.jsonValue() }),
  fc.record({ ref: fc.string({ minLength: 1 }), in: fc.array(fc.jsonValue(), { minLength: 0, maxLength: 5 }) }),
  fc.record({ ref: fc.string({ minLength: 1 }), contains: fc.jsonValue() }),
  fc.record({ ref: fc.string({ minLength: 1 }), exists: fc.boolean() }),
  fc.record({ ref: fc.string({ minLength: 1 }), matches: fc.constant("^[a-z]+$") }),
);

/** Arbitrary for a valid agent step (used as nested step in branches). */
const validAgentStepArb = validSlugArb.map((slug) => ({
  slug,
  type: "agent" as const,
  prompt: "do something",
}));

/** Arbitrary for a valid `if` step definition. */
const validIfStepArb = fc
  .record({
    slug: validSlugArb,
    condition: validConditionArb,
    thenSteps: fc.array(validAgentStepArb, { minLength: 1, maxLength: 3 }),
    hasElse: fc.boolean(),
    elseSteps: fc.array(validAgentStepArb, { minLength: 1, maxLength: 3 }),
  })
  .map(({ slug, condition, thenSteps, hasElse, elseSteps }) => {
    const step: Record<string, unknown> = {
      slug,
      type: "if",
      condition,
      // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword
      then: thenSteps,
    };
    if (hasElse) {
      step.else = elseSteps;
    }
    return step;
  });

/** Arbitrary for a valid `case` step definition. */
const validCaseStepArb = fc
  .record({
    slug: validSlugArb,
    match: fc.string({ minLength: 1 }),
    pathKeys: fc.array(fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/), { minLength: 1, maxLength: 4 }),
    pathSteps: fc.array(validAgentStepArb, { minLength: 1, maxLength: 2 }),
    hasDefault: fc.boolean(),
    defaultSteps: fc.array(validAgentStepArb, { minLength: 1, maxLength: 2 }),
  })
  .map(({ slug, match, pathKeys, pathSteps, hasDefault, defaultSteps }) => {
    const paths: Record<string, unknown[]> = {};
    for (const key of pathKeys) {
      paths[key] = pathSteps;
    }
    const step: Record<string, unknown> = {
      slug,
      type: "case",
      match,
      paths,
    };
    if (hasDefault) {
      step.default = defaultSteps;
    }
    return step;
  });

/** Arbitrary for a valid `waitFor` step definition. */
const validWaitForStepArb = fc
  .record({
    slug: validSlugArb,
    event: validEventArb,
    hasTimeout: fc.boolean(),
    timeout: fc.integer({ min: 1000, max: 604800000 }),
    hasSchema: fc.boolean(),
  })
  .map(({ slug, event, hasTimeout, timeout, hasSchema }) => {
    const step: Record<string, unknown> = {
      slug,
      type: "waitFor",
      event,
    };
    if (hasTimeout) {
      step.timeout = timeout;
    }
    if (hasSchema) {
      step.inputSchema = { type: "object" };
    }
    return step;
  });

/** Arbitrary for a valid `emit` step definition. */
const validEmitStepArb = fc
  .record({
    slug: validSlugArb,
    event: validEventArb,
    hasPayload: fc.boolean(),
    payload: fc.string({ minLength: 1 }),
  })
  .map(({ slug, event, hasPayload, payload }) => {
    const step: Record<string, unknown> = {
      slug,
      type: "emit",
      event,
    };
    if (hasPayload) {
      step.payload = payload;
    }
    return step;
  });

describe("schemas", () => {
  describe("ConditionSchema", () => {
    test("accepts condition with ref and single eq operator", () => {
      const condition = { ref: "{{steps.check.result}}", eq: "yes" };
      expect(Value.Check(ConditionSchema, condition)).toBe(true);
    });

    test("accepts condition with ref and exists operator (boolean)", () => {
      const condition = { ref: "{{steps.check.result}}", exists: true };
      expect(Value.Check(ConditionSchema, condition)).toBe(true);
    });

    test("accepts condition with ref and in operator (array)", () => {
      const condition = { ref: "{{steps.check.result}}", in: ["a", "b", "c"] };
      expect(Value.Check(ConditionSchema, condition)).toBe(true);
    });

    test("accepts condition with ref and matches operator (string)", () => {
      const condition = { ref: "{{steps.check.result}}", matches: "^yes" };
      expect(Value.Check(ConditionSchema, condition)).toBe(true);
    });

    test("rejects condition with empty ref", () => {
      const condition = { ref: "", eq: "yes" };
      expect(Value.Check(ConditionSchema, condition)).toBe(false);
    });

    test("rejects condition with missing ref", () => {
      const condition = { eq: "yes" };
      expect(Value.Check(ConditionSchema, condition)).toBe(false);
    });

    test("accepts condition with multiple operators at schema level (runtime enforces uniqueness)", () => {
      // Note: ConditionSchema allows multiple operators structurally;
      // the condition evaluator enforces single-operator at runtime.
      const condition = { ref: "x", eq: "a", neq: "b" };
      expect(Value.Check(ConditionSchema, condition)).toBe(true);
    });
  });

  describe("WaitForStepSchema", () => {
    test("accepts minimal valid waitFor step", () => {
      const step = { slug: "wait-approval", type: "waitFor", event: "approval.granted" };
      expect(Value.Check(WaitForStepSchema, step)).toBe(true);
    });

    test("accepts waitFor with timeout", () => {
      const step = { slug: "wait-approval", type: "waitFor", event: "approval.granted", timeout: 60000 };
      expect(Value.Check(WaitForStepSchema, step)).toBe(true);
    });

    test("accepts waitFor with inputSchema", () => {
      const step = {
        slug: "wait-data",
        type: "waitFor",
        event: "data.ready",
        inputSchema: { type: "object", properties: { name: { type: "string" } } },
      };
      expect(Value.Check(WaitForStepSchema, step)).toBe(true);
    });

    test("accepts waitFor with minimum timeout (1000ms)", () => {
      const step = { slug: "wait-min", type: "waitFor", event: "ping", timeout: 1000 };
      expect(Value.Check(WaitForStepSchema, step)).toBe(true);
    });

    test("accepts waitFor with maximum timeout (604800000ms)", () => {
      const step = { slug: "wait-max", type: "waitFor", event: "long-wait", timeout: 604800000 };
      expect(Value.Check(WaitForStepSchema, step)).toBe(true);
    });

    test("rejects waitFor with timeout below minimum", () => {
      const step = { slug: "wait-fast", type: "waitFor", event: "fast", timeout: 999 };
      expect(Value.Check(WaitForStepSchema, step)).toBe(false);
    });

    test("rejects waitFor with timeout above maximum", () => {
      const step = { slug: "wait-too-long", type: "waitFor", event: "forever", timeout: 604800001 };
      expect(Value.Check(WaitForStepSchema, step)).toBe(false);
    });

    test("rejects waitFor with non-integer timeout", () => {
      const step = { slug: "wait-float", type: "waitFor", event: "approx", timeout: 5000.5 };
      expect(Value.Check(WaitForStepSchema, step)).toBe(false);
    });

    test("rejects waitFor with invalid event name (uppercase)", () => {
      const step = { slug: "wait-bad", type: "waitFor", event: "Approval" };
      expect(Value.Check(WaitForStepSchema, step)).toBe(false);
    });

    test("rejects waitFor with invalid event name (starts with number)", () => {
      const step = { slug: "wait-num", type: "waitFor", event: "1event" };
      expect(Value.Check(WaitForStepSchema, step)).toBe(false);
    });

    test("rejects waitFor with empty event", () => {
      const step = { slug: "wait-empty", type: "waitFor", event: "" };
      expect(Value.Check(WaitForStepSchema, step)).toBe(false);
    });

    test("rejects waitFor with additional properties", () => {
      const step = { slug: "wait-extra", type: "waitFor", event: "ok", extra: true };
      expect(Value.Check(WaitForStepSchema, step)).toBe(false);
    });
  });

  describe("EmitStepSchema", () => {
    test("accepts minimal valid emit step", () => {
      const step = { slug: "signal-done", type: "emit", event: "task.completed" };
      expect(Value.Check(EmitStepSchema, step)).toBe(true);
    });

    test("accepts emit with payload", () => {
      const step = {
        slug: "signal-data",
        type: "emit",
        event: "data.ready",
        payload: "{{steps.process.result}}",
      };
      expect(Value.Check(EmitStepSchema, step)).toBe(true);
    });

    test("rejects emit with invalid event name", () => {
      const step = { slug: "signal-bad", type: "emit", event: "UPPERCASE" };
      expect(Value.Check(EmitStepSchema, step)).toBe(false);
    });

    test("rejects emit with empty event", () => {
      const step = { slug: "signal-empty", type: "emit", event: "" };
      expect(Value.Check(EmitStepSchema, step)).toBe(false);
    });

    test("rejects emit with additional properties", () => {
      const step = { slug: "signal-extra", type: "emit", event: "ok", extra: "bad" };
      expect(Value.Check(EmitStepSchema, step)).toBe(false);
    });

    test("rejects emit with non-string payload", () => {
      const step = { slug: "signal-num", type: "emit", event: "ok", payload: 123 };
      expect(Value.Check(EmitStepSchema, step)).toBe(false);
    });
  });

  describe("IfStepSchema", () => {
    test("accepts valid if step with then branch", () => {
      const step = {
        slug: "check-status",
        type: "if",
        condition: { ref: "{{steps.check.result}}", eq: "yes" },
        // biome-ignore lint/suspicious/noThenProperty: "then" is workflow branch keyword
        then: [{ slug: "do-thing", type: "agent", prompt: "do it" }],
      };
      expect(Value.Check(IfStepSchema, step)).toBe(true);
    });

    test("accepts if step with then and else branches", () => {
      const step = {
        slug: "check-status",
        type: "if",
        condition: { ref: "{{steps.check.result}}", neq: "skip" },
        // biome-ignore lint/suspicious/noThenProperty: "then" is workflow branch keyword
        then: [{ slug: "do-yes", type: "agent", prompt: "yes path" }],
        else: [{ slug: "do-no", type: "agent", prompt: "no path" }],
      };
      expect(Value.Check(IfStepSchema, step)).toBe(true);
    });

    test("rejects if step with empty then array", () => {
      const step = {
        slug: "check-empty",
        type: "if",
        condition: { ref: "x", eq: "y" },
        // biome-ignore lint/suspicious/noThenProperty: "then" is workflow branch keyword
        then: [],
      };
      expect(Value.Check(IfStepSchema, step)).toBe(false);
    });

    test("rejects if step with empty else array", () => {
      const step = {
        slug: "check-empty-else",
        type: "if",
        condition: { ref: "x", eq: "y" },
        // biome-ignore lint/suspicious/noThenProperty: "then" is workflow branch keyword
        then: [{ slug: "a", type: "agent", prompt: "p" }],
        else: [],
      };
      expect(Value.Check(IfStepSchema, step)).toBe(false);
    });

    test("rejects if step without condition", () => {
      const step = {
        slug: "no-condition",
        type: "if",
        // biome-ignore lint/suspicious/noThenProperty: "then" is workflow branch keyword
        then: [{ slug: "a", type: "agent", prompt: "p" }],
      };
      expect(Value.Check(IfStepSchema, step)).toBe(false);
    });

    test("rejects if step without then branch", () => {
      const step = {
        slug: "no-then",
        type: "if",
        condition: { ref: "x", eq: "y" },
      };
      expect(Value.Check(IfStepSchema, step)).toBe(false);
    });

    test("rejects if step with additional properties", () => {
      const step = {
        slug: "extra-props",
        type: "if",
        condition: { ref: "x", eq: "y" },
        // biome-ignore lint/suspicious/noThenProperty: "then" is workflow branch keyword
        then: [{ slug: "a", type: "agent", prompt: "p" }],
        extra: true,
      };
      expect(Value.Check(IfStepSchema, step)).toBe(false);
    });
  });

  describe("CaseStepSchema", () => {
    test("accepts valid case step", () => {
      const step = {
        slug: "route-type",
        type: "case",
        match: "{{steps.classify.result}}",
        paths: {
          urgent: [{ slug: "handle-urgent", type: "agent", prompt: "urgent" }],
          normal: [{ slug: "handle-normal", type: "agent", prompt: "normal" }],
        },
      };
      expect(Value.Check(CaseStepSchema, step)).toBe(true);
    });

    test("accepts case step with default branch", () => {
      const step = {
        slug: "route-default",
        type: "case",
        match: "{{steps.classify.result}}",
        paths: {
          urgent: [{ slug: "handle-urgent", type: "agent", prompt: "urgent" }],
        },
        default: [{ slug: "handle-fallback", type: "agent", prompt: "fallback" }],
      };
      expect(Value.Check(CaseStepSchema, step)).toBe(true);
    });

    test("rejects case step with empty match", () => {
      const step = {
        slug: "empty-match",
        type: "case",
        match: "",
        paths: { a: [{ slug: "s", type: "agent", prompt: "p" }] },
      };
      expect(Value.Check(CaseStepSchema, step)).toBe(false);
    });

    test("rejects case step without paths", () => {
      const step = {
        slug: "no-paths",
        type: "case",
        match: "something",
      };
      expect(Value.Check(CaseStepSchema, step)).toBe(false);
    });

    test("rejects case step with empty default array", () => {
      const step = {
        slug: "empty-default",
        type: "case",
        match: "x",
        paths: { a: [{ slug: "s", type: "agent", prompt: "p" }] },
        default: [],
      };
      expect(Value.Check(CaseStepSchema, step)).toBe(false);
    });

    test("rejects case step with additional properties", () => {
      const step = {
        slug: "extra-case",
        type: "case",
        match: "x",
        paths: { a: [{ slug: "s", type: "agent", prompt: "p" }] },
        extra: true,
      };
      expect(Value.Check(CaseStepSchema, step)).toBe(false);
    });
  });

  describe("StepSchema (recursive)", () => {
    test("accepts if step with nested agent steps in then branch", () => {
      const step = {
        slug: "check",
        type: "if",
        condition: { ref: "x", eq: "y" },
        // biome-ignore lint/suspicious/noThenProperty: "then" is workflow branch keyword
        then: [{ slug: "nested-agent", type: "agent", prompt: "do it" }],
      };
      expect(Value.Check(StepSchema, step)).toBe(true);
    });

    test("accepts case step with nested steps in paths", () => {
      const step = {
        slug: "route",
        type: "case",
        match: "{{steps.a.result}}",
        paths: {
          fast: [{ slug: "fast-step", type: "agent", prompt: "fast" }],
          slow: [{ slug: "slow-step", type: "agent", prompt: "slow" }],
        },
      };
      expect(Value.Check(StepSchema, step)).toBe(true);
    });

    test("accepts deeply nested control flow (if inside if then)", () => {
      const step = {
        slug: "outer-if",
        type: "if",
        condition: { ref: "x", eq: "y" },
        // biome-ignore lint/suspicious/noThenProperty: "then" is workflow branch keyword
        then: [
          {
            slug: "inner-if",
            type: "if",
            condition: { ref: "a", neq: "b" },
            // biome-ignore lint/suspicious/noThenProperty: "then" is workflow branch keyword
            then: [{ slug: "deep-step", type: "agent", prompt: "deep" }],
          },
        ],
      };
      expect(Value.Check(StepSchema, step)).toBe(true);
    });

    test("accepts waitFor step", () => {
      const step = { slug: "wait-signal", type: "waitFor", event: "approval" };
      expect(Value.Check(StepSchema, step)).toBe(true);
    });

    test("accepts emit step", () => {
      const step = { slug: "send-signal", type: "emit", event: "done" };
      expect(Value.Check(StepSchema, step)).toBe(true);
    });

    test("accepts generic (extension) step", () => {
      const step = { slug: "http-call", type: "http-request", url: "https://example.com" };
      expect(Value.Check(StepSchema, step)).toBe(true);
    });
  });

  describe("slug pattern validation", () => {
    test("rejects slug starting with uppercase", () => {
      const step = { slug: "Upper", type: "waitFor", event: "ok" };
      expect(Value.Check(WaitForStepSchema, step)).toBe(false);
    });

    test("rejects slug starting with number", () => {
      const step = { slug: "1step", type: "waitFor", event: "ok" };
      expect(Value.Check(WaitForStepSchema, step)).toBe(false);
    });

    test("rejects slug with spaces", () => {
      const step = { slug: "my step", type: "waitFor", event: "ok" };
      expect(Value.Check(WaitForStepSchema, step)).toBe(false);
    });

    test("rejects slug with underscores", () => {
      const step = { slug: "my_step", type: "waitFor", event: "ok" };
      expect(Value.Check(WaitForStepSchema, step)).toBe(false);
    });

    test("rejects empty slug", () => {
      const step = { slug: "", type: "waitFor", event: "ok" };
      expect(Value.Check(WaitForStepSchema, step)).toBe(false);
    });

    test("accepts slug with hyphens and numbers", () => {
      const step = { slug: "step-2-final", type: "waitFor", event: "ok" };
      expect(Value.Check(WaitForStepSchema, step)).toBe(true);
    });
  });

  describe("validateGlobalSlugUniqueness", () => {
    test("returns empty array for unique slugs", () => {
      const steps: WorkflowStep[] = [
        { slug: "a", type: "agent", prompt: "p" },
        { slug: "b", type: "agent", prompt: "p" },
        { slug: "c", type: "agent", prompt: "p" },
      ];
      expect(validateGlobalSlugUniqueness(steps)).toEqual([]);
    });

    test("returns empty array for empty step list", () => {
      expect(validateGlobalSlugUniqueness([])).toEqual([]);
    });

    test("detects duplicate slugs at top level", () => {
      const steps: WorkflowStep[] = [
        { slug: "dup", type: "agent", prompt: "p" },
        { slug: "dup", type: "agent", prompt: "p" },
      ];
      const result = validateGlobalSlugUniqueness(steps);
      expect(result).toContain("dup");
    });

    test("detects duplicates nested in if then branch", () => {
      const steps: WorkflowStep[] = [
        { slug: "shared", type: "agent", prompt: "p" },
        {
          slug: "check",
          type: "if",
          condition: { ref: "x", eq: "y" },
          // biome-ignore lint/suspicious/noThenProperty: "then" is workflow branch keyword
          then: [{ slug: "shared", type: "agent", prompt: "nested" }],
        } as unknown as WorkflowStep,
      ];
      const result = validateGlobalSlugUniqueness(steps);
      expect(result).toContain("shared");
    });

    test("detects duplicates nested in if else branch", () => {
      const steps: WorkflowStep[] = [
        { slug: "shared", type: "agent", prompt: "p" },
        {
          slug: "check",
          type: "if",
          condition: { ref: "x", eq: "y" },
          // biome-ignore lint/suspicious/noThenProperty: "then" is workflow branch keyword
          then: [{ slug: "then-step", type: "agent", prompt: "then" }],
          else: [{ slug: "shared", type: "agent", prompt: "else" }],
        } as unknown as WorkflowStep,
      ];
      const result = validateGlobalSlugUniqueness(steps);
      expect(result).toContain("shared");
    });

    test("detects duplicates nested in case paths", () => {
      const steps: WorkflowStep[] = [
        { slug: "shared", type: "agent", prompt: "p" },
        {
          slug: "route",
          type: "case",
          match: "x",
          paths: {
            a: [{ slug: "shared", type: "agent", prompt: "a" }],
          },
        } as unknown as WorkflowStep,
      ];
      const result = validateGlobalSlugUniqueness(steps);
      expect(result).toContain("shared");
    });

    test("detects duplicates nested in case default branch", () => {
      const steps: WorkflowStep[] = [
        { slug: "shared", type: "agent", prompt: "p" },
        {
          slug: "route",
          type: "case",
          match: "x",
          paths: { a: [{ slug: "path-a", type: "agent", prompt: "a" }] },
          default: [{ slug: "shared", type: "agent", prompt: "default" }],
        } as unknown as WorkflowStep,
      ];
      const result = validateGlobalSlugUniqueness(steps);
      expect(result).toContain("shared");
    });

    test("detects duplicates across if then and else branches", () => {
      const steps: WorkflowStep[] = [
        {
          slug: "check",
          type: "if",
          condition: { ref: "x", eq: "y" },
          // biome-ignore lint/suspicious/noThenProperty: "then" is workflow branch keyword
          then: [{ slug: "shared", type: "agent", prompt: "then" }],
          else: [{ slug: "shared", type: "agent", prompt: "else" }],
        } as unknown as WorkflowStep,
      ];
      const result = validateGlobalSlugUniqueness(steps);
      expect(result).toContain("shared");
    });

    test("detects duplicates across different case paths", () => {
      const steps: WorkflowStep[] = [
        {
          slug: "route",
          type: "case",
          match: "x",
          paths: {
            a: [{ slug: "shared", type: "agent", prompt: "a" }],
            b: [{ slug: "shared", type: "agent", prompt: "b" }],
          },
        } as unknown as WorkflowStep,
      ];
      const result = validateGlobalSlugUniqueness(steps);
      expect(result).toContain("shared");
    });
  });

  describe("property tests", () => {
    /**
     * **Validates: Requirements 9.1, 9.2, 9.3, 9.4**
     *
     * Property 13: Schema validation accepts valid control flow definitions
     *
     * For any well-formed if, case, waitFor, or emit node definition (slug
     * matching pattern, required fields present with correct types), TypeBox
     * Value.Check() against the respective schema SHALL return true.
     */
    describe("Property 13: Schema validation accepts valid definitions", () => {
      test("valid if steps pass IfStepSchema", () => {
        fc.assert(
          fc.property(validIfStepArb, (step) => {
            expect(Value.Check(IfStepSchema, step)).toBe(true);
          }),
          { numRuns: 100 },
        );
      });

      test("valid case steps pass CaseStepSchema", () => {
        fc.assert(
          fc.property(validCaseStepArb, (step) => {
            expect(Value.Check(CaseStepSchema, step)).toBe(true);
          }),
          { numRuns: 100 },
        );
      });

      test("valid waitFor steps pass WaitForStepSchema", () => {
        fc.assert(
          fc.property(validWaitForStepArb, (step) => {
            expect(Value.Check(WaitForStepSchema, step)).toBe(true);
          }),
          { numRuns: 100 },
        );
      });

      test("valid emit steps pass EmitStepSchema", () => {
        fc.assert(
          fc.property(validEmitStepArb, (step) => {
            expect(Value.Check(EmitStepSchema, step)).toBe(true);
          }),
          { numRuns: 100 },
        );
      });
    });

    /**
     * **Validates: Requirements 9.6**
     *
     * Property 14: Global slug uniqueness enforcement
     *
     * For any workflow definition where two or more steps (including those
     * nested in then, else, default, or paths branches) share the same slug
     * value, validateGlobalSlugUniqueness() SHALL return a non-empty array
     * containing the duplicate slug.
     */
    describe("Property 14: Global slug uniqueness enforcement", () => {
      test("detects duplicates when same slug appears at top level", () => {
        fc.assert(
          fc.property(validSlugArb, fc.array(validSlugArb, { minLength: 0, maxLength: 5 }), (dupSlug, otherSlugs) => {
            // Ensure the duplicate slug appears at least twice at the top level
            const uniqueOthers = otherSlugs.filter((s) => s !== dupSlug);
            const steps: WorkflowStep[] = [
              { slug: dupSlug, type: "agent", prompt: "first" },
              ...uniqueOthers.map((s) => ({ slug: s, type: "agent" as const, prompt: "p" })),
              { slug: dupSlug, type: "agent", prompt: "second" },
            ];
            const result = validateGlobalSlugUniqueness(steps);
            expect(result).toContain(dupSlug);
          }),
          { numRuns: 100 },
        );
      });

      test("detects duplicates when same slug appears in nested if branch", () => {
        fc.assert(
          fc.property(validSlugArb, validSlugArb, (dupSlug, ifSlug) => {
            // Avoid collision between the if node's own slug and the duplicated slug
            const safeIfSlug = ifSlug === dupSlug ? `${ifSlug}-if` : ifSlug;
            const steps: WorkflowStep[] = [
              { slug: dupSlug, type: "agent", prompt: "top" },
              {
                slug: safeIfSlug,
                type: "if",
                condition: { ref: "x", eq: "y" },
                // biome-ignore lint/suspicious/noThenProperty: "then" is workflow branch keyword
                then: [{ slug: dupSlug, type: "agent", prompt: "nested" }],
              } as unknown as WorkflowStep,
            ];
            const result = validateGlobalSlugUniqueness(steps);
            expect(result).toContain(dupSlug);
          }),
          { numRuns: 100 },
        );
      });

      test("detects duplicates when same slug appears in nested case path", () => {
        fc.assert(
          fc.property(validSlugArb, validSlugArb, (dupSlug, caseSlug) => {
            const safeCaseSlug = caseSlug === dupSlug ? `${caseSlug}-case` : caseSlug;
            const steps: WorkflowStep[] = [
              { slug: dupSlug, type: "agent", prompt: "top" },
              {
                slug: safeCaseSlug,
                type: "case",
                match: "x",
                paths: {
                  a: [{ slug: dupSlug, type: "agent", prompt: "nested" }],
                },
              } as unknown as WorkflowStep,
            ];
            const result = validateGlobalSlugUniqueness(steps);
            expect(result).toContain(dupSlug);
          }),
          { numRuns: 100 },
        );
      });

      test("returns empty array when all slugs are unique", () => {
        // Generate a list of unique slugs and confirm no duplicates detected
        fc.assert(
          fc.property(
            fc.uniqueArray(validSlugArb, { minLength: 1, maxLength: 10, comparator: (a, b) => a === b }),
            (slugs) => {
              const steps: WorkflowStep[] = slugs.map((s) => ({
                slug: s,
                type: "agent" as const,
                prompt: "p",
              }));
              const result = validateGlobalSlugUniqueness(steps);
              expect(result).toEqual([]);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
