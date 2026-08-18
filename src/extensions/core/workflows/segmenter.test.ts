import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { WorkflowStep } from "./schemas";
import { CONTROL_FLOW_TYPES, segmentWorkflow } from "./segmenter";

/** Arbitrary for a valid step slug. */
const slugArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/).filter((s) => s.length >= 1);

/** Arbitrary for a non-CF (agent) step. */
const agentStepArb: fc.Arbitrary<WorkflowStep> = slugArb.map((slug) => ({
  slug,
  type: "agent",
  prompt: "do something",
}));

/** Arbitrary for a non-CF generic step (custom extension type, not in CONTROL_FLOW_TYPES). */
const genericStepArb: fc.Arbitrary<WorkflowStep> = fc
  .record({
    slug: slugArb,
    type: fc.constantFrom("http-request", "webhook-call", "transform", "notify"),
  })
  .map(({ slug, type }) => ({ slug, type }));

/** Arbitrary for a control flow step. */
const cfStepArb: fc.Arbitrary<WorkflowStep> = fc
  .record({
    slug: slugArb,
    type: fc.constantFrom(...CONTROL_FLOW_TYPES),
  })
  .map(({ slug, type }) => ({ slug, type }));

/** Arbitrary for any non-CF step (agent or generic). */
const nonCfStepArb: fc.Arbitrary<WorkflowStep> = fc.oneof(agentStepArb, genericStepArb);

/** Arbitrary for a mixed step list with both CF and non-CF steps. */
const mixedStepListArb: fc.Arbitrary<WorkflowStep[]> = fc.array(fc.oneof(nonCfStepArb, cfStepArb), {
  minLength: 1,
  maxLength: 30,
});

/** Arbitrary for a step list with only non-CF steps. */
const sequentialStepListArb: fc.Arbitrary<WorkflowStep[]> = fc.array(nonCfStepArb, {
  minLength: 1,
  maxLength: 30,
});

describe("segmentWorkflow", () => {
  describe("example-based tests", () => {
    test("returns empty array for empty step list", () => {
      const result = segmentWorkflow([]);
      expect(result).toEqual([]);
    });

    test("returns single segment for steps with no CF nodes", () => {
      const steps: WorkflowStep[] = [
        { slug: "step-a", type: "agent", prompt: "first" },
        { slug: "step-b", type: "agent", prompt: "second" },
        { slug: "step-c", type: "http-request", url: "https://example.com" },
      ];

      const segments = segmentWorkflow(steps);

      expect(segments).toHaveLength(1);
      expect(segments[0]!.index).toBe(0);
      expect(segments[0]!.steps).toEqual(steps);
      expect(segments[0]!.isControlFlow).toBe(false);
    });

    test("isolates a single CF node between non-CF steps", () => {
      const steps: WorkflowStep[] = [
        { slug: "step-a", type: "agent", prompt: "first" },
        { slug: "check", type: "if" },
        { slug: "step-b", type: "agent", prompt: "second" },
      ];

      const segments = segmentWorkflow(steps);

      expect(segments).toHaveLength(3);
      // First segment: non-CF steps before the CF node
      expect(segments[0]!.steps).toEqual([steps[0]!]);
      expect(segments[0]!.isControlFlow).toBe(false);
      // Second segment: the CF node
      expect(segments[1]!.steps).toEqual([steps[1]!]);
      expect(segments[1]!.isControlFlow).toBe(true);
      // Third segment: non-CF steps after the CF node
      expect(segments[2]!.steps).toEqual([steps[2]!]);
      expect(segments[2]!.isControlFlow).toBe(false);
    });

    test("handles consecutive CF nodes as separate segments", () => {
      const steps: WorkflowStep[] = [
        { slug: "branch-a", type: "if" },
        { slug: "branch-b", type: "case" },
        { slug: "wait", type: "waitFor" },
      ];

      const segments = segmentWorkflow(steps);

      expect(segments).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        expect(segments[i]!.index).toBe(i);
        expect(segments[i]!.steps).toHaveLength(1);
        expect(segments[i]!.steps[0]).toBe(steps[i]);
        expect(segments[i]!.isControlFlow).toBe(true);
      }
    });

    test("emit is treated as a regular (non-CF) step type", () => {
      const steps: WorkflowStep[] = [
        { slug: "branch-a", type: "if" },
        { slug: "signal", type: "emit", event: "test" },
      ];

      const segments = segmentWorkflow(steps);

      expect(segments).toHaveLength(2);
      expect(segments[0]!.isControlFlow).toBe(true);
      expect(segments[0]!.steps[0]!.slug).toBe("branch-a");
      expect(segments[1]!.isControlFlow).toBe(false);
      expect(segments[1]!.steps[0]!.slug).toBe("signal");
    });

    test("assigns sequential index values to segments", () => {
      const steps: WorkflowStep[] = [
        { slug: "a", type: "agent", prompt: "p" },
        { slug: "b", type: "agent", prompt: "p" },
        { slug: "c", type: "if" },
        { slug: "d", type: "agent", prompt: "p" },
      ];

      const segments = segmentWorkflow(steps);

      for (let i = 0; i < segments.length; i++) {
        expect(segments[i]!.index).toBe(i);
      }
    });
  });

  describe("property tests", () => {
    /**
     * **Validates: Requirements 1.1, 1.2**
     *
     * Property 1: Segmenter preserves all steps
     *
     * For any flat step list, the union of all steps across all segments
     * returned by segmentWorkflow() equals the original step list in order.
     */
    test("Property 1: Segmenter preserves all steps", () => {
      fc.assert(
        fc.property(mixedStepListArb, (steps) => {
          const segments = segmentWorkflow(steps);
          const reconstructed = segments.flatMap((seg) => seg.steps);

          expect(reconstructed).toHaveLength(steps.length);
          for (let i = 0; i < steps.length; i++) {
            expect(reconstructed[i]).toBe(steps[i]);
          }
        }),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 1.2**
     *
     * Property 2: Segmenter isolates control flow nodes
     *
     * For any step list containing at least one control flow node, each CF node
     * appears as the sole step in its own segment with isControlFlow: true,
     * and no segment with isControlFlow: false contains a CF node.
     */
    test("Property 2: Segmenter isolates control flow nodes", () => {
      // Ensure at least one CF node in the list
      const stepsWithCfArb = fc
        .tuple(
          fc.array(nonCfStepArb, { minLength: 0, maxLength: 10 }),
          cfStepArb,
          fc.array(fc.oneof(nonCfStepArb, cfStepArb), { minLength: 0, maxLength: 10 }),
        )
        .map(([before, cf, after]) => [...before, cf, ...after]);

      fc.assert(
        fc.property(stepsWithCfArb, (steps) => {
          const segments = segmentWorkflow(steps);

          for (const segment of segments) {
            if (segment.isControlFlow) {
              // CF segments must have exactly one step which is a CF type
              expect(segment.steps).toHaveLength(1);
              expect(CONTROL_FLOW_TYPES.has(segment.steps[0]!.type)).toBe(true);
            } else {
              // Non-CF segments must not contain any CF steps
              for (const step of segment.steps) {
                expect(CONTROL_FLOW_TYPES.has(step.type)).toBe(false);
              }
            }
          }
        }),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 1.1, 12.1**
     *
     * Property 3: Single segment for sequential-only workflows
     *
     * For any step list containing zero control flow nodes,
     * segmentWorkflow() returns exactly one segment containing all steps
     * in their original order with isControlFlow: false.
     */
    test("Property 3: Single segment for sequential-only workflows", () => {
      fc.assert(
        fc.property(sequentialStepListArb, (steps) => {
          const segments = segmentWorkflow(steps);

          expect(segments).toHaveLength(1);
          expect(segments[0]!.index).toBe(0);
          expect(segments[0]!.isControlFlow).toBe(false);
          expect(segments[0]!.steps).toHaveLength(steps.length);
          for (let i = 0; i < steps.length; i++) {
            expect(segments[0]!.steps[i]).toBe(steps[i]);
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});
