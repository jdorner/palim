import { describe, expect, expectTypeOf, test } from "bun:test";
import type { PortalTriggerConfig } from "@shared/workflows";
import { Value } from "@sinclair/typebox/value";
import fc from "fast-check";
import {
  ConditionSchema,
  DagCaseStepSchema,
  DagEmitStepSchema,
  DagIfStepSchema,
  DagWaitForStepSchema,
  DagWorkflowDefinitionSchema,
  OutputSchemaSchema,
  type Trigger,
} from "./schemas";

describe("PortalTriggerConfig", () => {
  test("the shared interface matches the TypeBox trigger schema", () => {
    // Compile-time check (enforced by `bunx tsc --noEmit`): the frontend's
    // shared interface must not drift from the schema the backend validates.
    expectTypeOf<NonNullable<Trigger["portal"]>>().toEqualTypeOf<PortalTriggerConfig>();
  });
});

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Valid event name: starts with lowercase letter, followed by lowercase alphanumeric, dots, hyphens, or underscores. */
const validEventArb = fc.stringMatching(/^[a-z][a-z0-9._-]{0,30}$/).filter((s) => s.length >= 1 && s.length <= 128);

/** Arbitrary for a valid `waitFor` step definition. */
const validWaitForStepArb = fc
  .record({
    event: validEventArb,
    hasTimeout: fc.boolean(),
    timeout: fc.integer({ min: 1000, max: 604800000 }),
    hasSchema: fc.boolean(),
  })
  .map(({ event, hasTimeout, timeout, hasSchema }) => {
    const step: Record<string, unknown> = { type: "waitFor", event };
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
    event: validEventArb,
    hasPayload: fc.boolean(),
    payload: fc.string({ minLength: 1 }),
  })
  .map(({ event, hasPayload, payload }) => {
    const step: Record<string, unknown> = { type: "emit", event };
    if (hasPayload) {
      step.payload = payload;
    }
    return step;
  });

/** Minimal workflow definition with a single step under the given slug. */
function workflowWithSlug(slug: string): Record<string, unknown> {
  return {
    name: "wf",
    trigger: { type: "manual" },
    steps: { [slug]: { type: "waitFor", event: "ok" } },
    edges: [],
  };
}

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

  describe("DagWaitForStepSchema", () => {
    test("accepts minimal valid waitFor step", () => {
      const step = { type: "waitFor", event: "approval.granted" };
      expect(Value.Check(DagWaitForStepSchema, step)).toBe(true);
    });

    test("accepts waitFor with timeout", () => {
      const step = { type: "waitFor", event: "approval.granted", timeout: 60000 };
      expect(Value.Check(DagWaitForStepSchema, step)).toBe(true);
    });

    test("accepts waitFor with inputSchema", () => {
      const step = {
        type: "waitFor",
        event: "data.ready",
        inputSchema: { type: "object", properties: { name: { type: "string" } } },
      };
      expect(Value.Check(DagWaitForStepSchema, step)).toBe(true);
    });

    test("accepts waitFor with minimum timeout (1000ms)", () => {
      const step = { type: "waitFor", event: "ping", timeout: 1000 };
      expect(Value.Check(DagWaitForStepSchema, step)).toBe(true);
    });

    test("accepts waitFor with maximum timeout (604800000ms)", () => {
      const step = { type: "waitFor", event: "long-wait", timeout: 604800000 };
      expect(Value.Check(DagWaitForStepSchema, step)).toBe(true);
    });

    test("rejects waitFor with timeout below minimum", () => {
      const step = { type: "waitFor", event: "fast", timeout: 999 };
      expect(Value.Check(DagWaitForStepSchema, step)).toBe(false);
    });

    test("rejects waitFor with timeout above maximum", () => {
      const step = { type: "waitFor", event: "forever", timeout: 604800001 };
      expect(Value.Check(DagWaitForStepSchema, step)).toBe(false);
    });

    test("rejects waitFor with non-integer timeout", () => {
      const step = { type: "waitFor", event: "approx", timeout: 5000.5 };
      expect(Value.Check(DagWaitForStepSchema, step)).toBe(false);
    });

    test("rejects waitFor with invalid event name (uppercase)", () => {
      const step = { type: "waitFor", event: "Approval" };
      expect(Value.Check(DagWaitForStepSchema, step)).toBe(false);
    });

    test("rejects waitFor with invalid event name (starts with number)", () => {
      const step = { type: "waitFor", event: "1event" };
      expect(Value.Check(DagWaitForStepSchema, step)).toBe(false);
    });

    test("rejects waitFor with empty event", () => {
      const step = { type: "waitFor", event: "" };
      expect(Value.Check(DagWaitForStepSchema, step)).toBe(false);
    });

    test("rejects waitFor with additional properties", () => {
      const step = { type: "waitFor", event: "ok", extra: true };
      expect(Value.Check(DagWaitForStepSchema, step)).toBe(false);
    });
  });

  describe("DagEmitStepSchema", () => {
    test("accepts minimal valid emit step", () => {
      const step = { type: "emit", event: "task.completed" };
      expect(Value.Check(DagEmitStepSchema, step)).toBe(true);
    });

    test("accepts emit with payload", () => {
      const step = { type: "emit", event: "data.ready", payload: "{{steps.process.result}}" };
      expect(Value.Check(DagEmitStepSchema, step)).toBe(true);
    });

    test("rejects emit with invalid event name", () => {
      const step = { type: "emit", event: "UPPERCASE" };
      expect(Value.Check(DagEmitStepSchema, step)).toBe(false);
    });

    test("rejects emit with empty event", () => {
      const step = { type: "emit", event: "" };
      expect(Value.Check(DagEmitStepSchema, step)).toBe(false);
    });

    test("rejects emit with additional properties", () => {
      const step = { type: "emit", event: "ok", extra: "bad" };
      expect(Value.Check(DagEmitStepSchema, step)).toBe(false);
    });

    test("rejects emit with non-string payload", () => {
      const step = { type: "emit", event: "ok", payload: 123 };
      expect(Value.Check(DagEmitStepSchema, step)).toBe(false);
    });
  });

  describe("DagIfStepSchema", () => {
    test("accepts if step with condition", () => {
      const step = { type: "if", condition: { ref: "{{steps.check.result}}", eq: "yes" } };
      expect(Value.Check(DagIfStepSchema, step)).toBe(true);
    });

    test("accepts if step with branch labels", () => {
      // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword
      const step = { type: "if", condition: { ref: "x", eq: "y" }, branchLabels: { then: "Yes", else: "No" } };
      expect(Value.Check(DagIfStepSchema, step)).toBe(true);
    });

    test("rejects if step without condition", () => {
      expect(Value.Check(DagIfStepSchema, { type: "if" })).toBe(false);
    });

    test("rejects if step with additional properties", () => {
      const step = { type: "if", condition: { ref: "x", eq: "y" }, extra: true };
      expect(Value.Check(DagIfStepSchema, step)).toBe(false);
    });
  });

  describe("DagCaseStepSchema", () => {
    test("accepts case step with paths and default", () => {
      const step = { type: "case", match: "{{steps.classify.result}}", paths: ["urgent", "normal"], default: "other" };
      expect(Value.Check(DagCaseStepSchema, step)).toBe(true);
    });

    test("rejects case step with empty match", () => {
      expect(Value.Check(DagCaseStepSchema, { type: "case", match: "", paths: ["a"] })).toBe(false);
    });

    test("rejects case step with empty paths", () => {
      expect(Value.Check(DagCaseStepSchema, { type: "case", match: "x", paths: [] })).toBe(false);
    });
  });

  describe("step slug validation (steps map keys)", () => {
    test("accepts slug with hyphens and numbers", () => {
      expect(Value.Check(DagWorkflowDefinitionSchema, workflowWithSlug("step-2-final"))).toBe(true);
    });

    for (const slug of ["Upper", "1step", "my step", "my_step"]) {
      test(`rejects slug "${slug}"`, () => {
        expect(Value.Check(DagWorkflowDefinitionSchema, workflowWithSlug(slug))).toBe(false);
      });
    }
  });

  describe("workflow group", () => {
    test("accepts a free-text group", () => {
      expect(Value.Check(DagWorkflowDefinitionSchema, { ...workflowWithSlug("a"), group: "Mail & Inbox" })).toBe(true);
    });

    for (const group of ["", " finance", "finance ", "x".repeat(65)]) {
      test(`rejects group ${JSON.stringify(group.length > 10 ? `${group.slice(0, 5)}…` : group)}`, () => {
        expect(Value.Check(DagWorkflowDefinitionSchema, { ...workflowWithSlug("a"), group })).toBe(false);
      });
    }
  });

  describe("property tests", () => {
    test("valid waitFor steps pass DagWaitForStepSchema", () => {
      fc.assert(
        fc.property(validWaitForStepArb, (step) => {
          expect(Value.Check(DagWaitForStepSchema, step)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    test("valid emit steps pass DagEmitStepSchema", () => {
      fc.assert(
        fc.property(validEmitStepArb, (step) => {
          expect(Value.Check(DagEmitStepSchema, step)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe("OutputSchemaSchema", () => {
  test("accepts leaves, nested maps, and one-element item arrays", () => {
    expect(
      Value.Check(OutputSchemaSchema, {
        id: "string",
        meta: { size: "number", extra: "object" },
        tags: ["string"],
        rows: [{ id: "number", cells: [["any"]] }],
      }),
    ).toBe(true);
  });

  test("rejects empty or multi-element arrays", () => {
    expect(Value.Check(OutputSchemaSchema, { tags: [] })).toBe(false);
    expect(Value.Check(OutputSchemaSchema, { tags: ["string", "number"] })).toBe(false);
  });

  test("rejects non-string leaves", () => {
    expect(Value.Check(OutputSchemaSchema, { id: 1 })).toBe(false);
  });
});
