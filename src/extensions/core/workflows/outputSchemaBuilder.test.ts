import { describe, expect, test } from "bun:test";
import { type TSchema, Type } from "@sinclair/typebox";
import fc from "fast-check";
import { buildOutputSchemas } from "./index";
import { compileOutputSchema } from "./outputSchemaCompiler";
import type { DagWorkflowDefinition, OutputSchemaShorthand } from "./schemas";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Recognized leaf type hints the compiler maps to `{ type: <t> }`. */
const RECOGNIZED_HINTS = ["string", "number", "boolean"] as const;

/** Property keys: non-empty identifier-like strings so keys are stable and distinct. */
const propertyKeyArb = fc.stringMatching(/^[a-z][a-zA-Z0-9_]{0,7}$/).filter((s) => s.length >= 1);

/** Step slug keys matching the DAG slug pattern (`^[a-z][a-z0-9-]*$`). */
const slugArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/).filter((s) => s.length >= 1);

/** A recognized leaf type-hint string. */
const recognizedLeafArb = fc.constantFrom(...RECOGNIZED_HINTS);

/**
 * Builds a shorthand arbitrary containing only recognized leaves and nested maps.
 * Kept shallow so generated fixtures stay focused and fast.
 */
const recognizedShorthandArb: fc.Arbitrary<OutputSchemaShorthand> = fc.letrec<{
  node: string | OutputSchemaShorthand;
  map: OutputSchemaShorthand;
}>((tie) => ({
  node: fc.oneof({ maxDepth: 2, depthSize: "small" }, recognizedLeafArb, tie("map")),
  map: fc.dictionary(propertyKeyArb, tie("node"), { minKeys: 0, maxKeys: 3 }),
})).map;

/** Trigger types accepted by the DAG trigger schema. */
const triggerTypeArb = fc.constantFrom("webhook", "schedule", "manual", "filewatcher");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Type guard for a plain object node (used while walking emitted schemas). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds a minimal `DagWorkflowDefinition`-shaped fixture. `buildOutputSchemas`
 * only reads `definition.steps` (each entry's `.type` and `.outputSchema`) and
 * `definition.trigger.type`/`.outputSchema`, so a focused object literal cast to
 * the definition type is sufficient and realistic.
 *
 * @param steps - Map of slug to a minimal step definition (`type` + optional shorthand)
 * @param trigger - Trigger type plus optional shorthand
 * @returns A definition object cast to `DagWorkflowDefinition`
 */
function makeDefinition(
  steps: Record<string, { type: string; outputSchema?: OutputSchemaShorthand }>,
  trigger: { type: string; outputSchema?: OutputSchemaShorthand } = { type: "manual" },
): DagWorkflowDefinition {
  return {
    name: "fixture-workflow",
    trigger,
    steps,
    edges: [],
  } as unknown as DagWorkflowDefinition;
}

/**
 * A resolver that never returns a handler schema (handler-absent scenarios).
 *
 * @returns `undefined` for every step type
 */
function noHandler(): TSchema | undefined {
  return undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildOutputSchemas", () => {
  describe("source precedence", () => {
    test("Output-schema source precedence", () => {
      fc.assert(
        fc.property(
          slugArb,
          propertyKeyArb,
          recognizedShorthandArb,
          propertyKeyArb,
          fc.boolean(),
          fc.boolean(),
          (slug, stepType, handAuthored, handlerKey, hasHandAuthored, hasHandler) => {
            // A handler TypeBox schema distinct from the hand-authored shorthand.
            const handlerSchema = Type.Object({ [handlerKey]: Type.String() });
            const serializedHandler = JSON.parse(JSON.stringify(handlerSchema)) as Record<string, unknown>;
            const compiledHandAuthored = compileOutputSchema(handAuthored);

            const stepDef: { type: string; outputSchema?: OutputSchemaShorthand } = { type: stepType };
            if (hasHandAuthored) {
              stepDef.outputSchema = handAuthored;
            }

            const definition = makeDefinition({ [slug]: stepDef });
            const resolver = (type: string): TSchema | undefined =>
              hasHandler && type === stepType ? handlerSchema : undefined;

            const { outputSchemas } = buildOutputSchemas(definition, resolver);
            const emitted = outputSchemas.steps[slug];

            if (hasHandAuthored) {
              // Combinations 1 & 2: hand-authored wins (over handler and over absence).
              expect(emitted).toEqual(compiledHandAuthored);
              // Explicitly NOT the handler schema (when a handler was present).
              if (hasHandler) {
                expect(emitted).not.toEqual(serializedHandler);
              }
            } else if (hasHandler) {
              // Combination 3: no hand-authored, handler present -> serialized handler.
              expect(emitted).toEqual(serializedHandler);
            } else {
              // Combination 4: neither -> slug absent.
              expect(slug in outputSchemas.steps).toBe(false);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("canonical JSON Schema output", () => {
    test("Every emitted schema is canonical JSON Schema", () => {
      // A step arbitrary that may carry a hand-authored shorthand and a type that
      // may or may not resolve to a handler schema.
      const stepArb = fc.record({
        type: propertyKeyArb,
        outputSchema: fc.option(recognizedShorthandArb, { nil: undefined }),
      });

      fc.assert(
        fc.property(
          fc.dictionary(slugArb, stepArb, { minKeys: 0, maxKeys: 4 }),
          triggerTypeArb,
          fc.option(recognizedShorthandArb, { nil: undefined }),
          fc.boolean(),
          (steps, triggerType, triggerShorthand, provideHandlers) => {
            const definition = makeDefinition(steps, { type: triggerType, outputSchema: triggerShorthand });
            // When enabled, every step type resolves to a simple handler schema.
            const resolver = provideHandlers ? (): TSchema => Type.Object({ ok: Type.Boolean() }) : noHandler;

            const { outputSchemas } = buildOutputSchemas(definition, resolver);

            // Every emitted step value is a plain JSON Schema record (never a string).
            for (const value of Object.values(outputSchemas.steps)) {
              expect(typeof value).not.toBe("string");
              expect(isRecord(value)).toBe(true);
            }

            // A non-null trigger schema is likewise a plain JSON Schema record.
            if (outputSchemas.trigger !== null) {
              expect(typeof outputSchemas.trigger).not.toBe("string");
              expect(isRecord(outputSchemas.trigger)).toBe(true);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("non-fatal resolution", () => {
    test("New validation and compilation are non-fatal", () => {
      fc.assert(
        fc.property(fc.uniqueArray(slugArb, { minLength: 1, maxLength: 5 }), fc.integer(), (slugs, throwIndexSeed) => {
          // Pick one slug whose handler resolution will throw; every other slug
          // resolves normally to a valid handler schema.
          const throwIndex = ((throwIndexSeed % slugs.length) + slugs.length) % slugs.length;
          const throwingSlug = slugs[throwIndex]!;
          // Each slug gets a distinct type so the resolver can target one type.
          const stepEntries: Record<string, { type: string }> = {};
          for (const slug of slugs) {
            stepEntries[slug] = { type: `type-${slug}` };
          }

          const definition = makeDefinition(stepEntries);
          const throwingType = `type-${throwingSlug}`;
          const resolver = (type: string): TSchema | undefined => {
            if (type === throwingType) {
              throw new Error("resolver failure for this step type");
            }
            return Type.Object({ ok: Type.Boolean() });
          };

          let result: ReturnType<typeof buildOutputSchemas> | undefined;
          // The builder must never throw despite the resolver throwing.
          expect(() => {
            result = buildOutputSchemas(definition, resolver);
          }).not.toThrow();

          expect(result).not.toBeUndefined();
          const steps = result!.outputSchemas.steps;

          // The throwing step is skipped (absent from the emitted steps).
          expect(throwingSlug in steps).toBe(false);

          // Every other step still resolved and appears in the emitted steps.
          for (const slug of slugs) {
            if (slug !== throwingSlug) {
              expect(slug in steps).toBe(true);
            }
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});
