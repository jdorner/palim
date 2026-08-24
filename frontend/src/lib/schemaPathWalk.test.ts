import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { type OutputSchema, walkSchemaPath } from "../../../shared/workflows";
import { getOutputSchemaSuggestions, getSuggestions, type ScopeConfig, type Suggestion } from "./templateScope";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Recognized primitive leaf types used in generated leaf nodes. */
const PRIMITIVE_TYPES = ["string", "number", "boolean"] as const;

/** Property keys: identifier-like strings so keys are stable, distinct, and prefix-safe. */
const propertyKeyArb = fc.stringMatching(/^[a-z][a-zA-Z0-9_]{0,7}$/).filter((s) => s.length >= 1);

/** A primitive leaf JSON Schema node, e.g. `{ type: "string" }`. */
const primitiveLeafArb: fc.Arbitrary<OutputSchema> = fc
  .constantFrom(...PRIMITIVE_TYPES)
  .map((t) => ({ type: t }) as OutputSchema);

/** An unconstrained leaf node `{}` (no type, no properties). */
const unconstrainedLeafArb: fc.Arbitrary<OutputSchema> = fc.constant({} as OutputSchema);

/** Any leaf node: a primitive-typed node or an unconstrained `{}` node. */
const leafArb: fc.Arbitrary<OutputSchema> = fc.oneof(primitiveLeafArb, unconstrainedLeafArb);

/**
 * Generates a canonical JSON Schema object tree: object nodes carry
 * `type: "object"` and a `properties` map, and leaf nodes carry a primitive
 * `type` or are the unconstrained `{}`. Depth is bounded so shrinking stays fast.
 */
const schemaTreeArb: fc.Arbitrary<OutputSchema> = fc.letrec<{
  node: OutputSchema;
  objectNode: OutputSchema;
}>((tie) => ({
  node: fc.oneof({ maxDepth: 3, depthSize: "small" }, leafArb, tie("objectNode")),
  objectNode: fc
    .dictionary(propertyKeyArb, tie("node"), { minKeys: 0, maxKeys: 4 })
    .map((properties) => ({ type: "object", properties }) as OutputSchema),
})).objectNode;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Type guard for a plain object node. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reports whether a JSON Schema node is an object node (has children).
 *
 * Mirrors the walker rule: a node is an object when `type === "object"` or when
 * it exposes a `properties` map.
 *
 * @param node - The schema node to classify
 * @returns True when the node is an object node, false for leaf nodes
 */
function isObjectNode(node: unknown): boolean {
  if (!isRecord(node)) return false;
  return node.type === "object" || isRecord(node.properties);
}

/**
 * Collects every dot-path (as segment arrays) reachable in a schema tree,
 * including the empty root path. Descends only into object nodes.
 *
 * @param schema - The schema tree to enumerate
 * @param prefix - Accumulated path prefix (used internally during recursion)
 * @returns All reachable paths, root-first
 */
function collectSchemaPaths(schema: OutputSchema, prefix: string[] = []): string[][] {
  const paths: string[][] = [prefix];
  const properties = isRecord(schema.properties) ? (schema.properties as Record<string, unknown>) : undefined;
  if (properties === undefined) return paths;
  for (const key of Object.keys(properties)) {
    const child = properties[key];
    if (isObjectNode(child)) {
      paths.push(...collectSchemaPaths(child as OutputSchema, [...prefix, key]));
    }
  }
  return paths;
}

/**
 * Reference expectation for the immediate children of a node reached by walking
 * `path` from `schema`, independent of the production walker. Returns the child
 * keys with terminal classification, or null when the path fails to resolve or
 * lands on a leaf (no children).
 *
 * @param schema - The schema tree to walk
 * @param path - The dot-path segments to descend
 * @returns Child keys with terminal flags, or null when there are no children
 */
function expectedChildren(schema: OutputSchema, path: string[]): { key: string; terminal: boolean }[] | null {
  let current: unknown = schema;
  for (const segment of path) {
    if (!isRecord(current) || !isRecord(current.properties)) return null;
    const next = (current.properties as Record<string, unknown>)[segment];
    if (next === undefined) return null;
    current = next;
  }
  if (!isRecord(current) || !isRecord(current.properties)) return null;
  const properties = current.properties as Record<string, unknown>;
  return Object.keys(properties).map((key) => ({
    key,
    terminal: !isObjectNode(properties[key]),
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getOutputSchemaSuggestions", () => {
  describe("completion soundness", () => {
    test("Feature: workflow-schema-dataflow, Property 8: Completion soundness over the resolved schema", () => {
      fc.assert(
        fc.property(schemaTreeArb, (schema) => {
          const paths = collectSchemaPaths(schema);

          for (const path of paths) {
            const suggestions = getOutputSchemaSuggestions(schema, path, "");
            const expected = expectedChildren(schema, path);

            // Cross-check the resolver used by the completion logic.
            const resolved = walkSchemaPath(schema, path);

            if (expected === null) {
              // Path fails to resolve or lands on a leaf: no suggestions.
              expect(suggestions).toEqual([]);
              continue;
            }

            // Suggestions are EXACTLY the immediate child property names.
            const suggestedLabels = new Set(suggestions.map((s) => s.label));
            const expectedLabels = new Set(expected.map((e) => e.key));
            expect(suggestedLabels).toEqual(expectedLabels);
            expect(new Set(resolved.children)).toEqual(expectedLabels);

            // Each suggestion is terminal iff its child node is a leaf.
            const terminalByLabel = new Map(suggestions.map((s) => [s.label, s.terminal]));
            for (const child of expected) {
              expect(terminalByLabel.get(child.key)).toBe(child.terminal);
            }
          }
        }),
        { numRuns: 100 },
      );
    });

    test("Feature: workflow-schema-dataflow, Property 8: empty when the schema is null (via dispatcher)", () => {
      fc.assert(
        fc.property(
          // Arbitrary suffix path after `trigger.payload` / `steps.slug.result`.
          fc.array(propertyKeyArb, { maxLength: 4 }),
          propertyKeyArb,
          (suffix, prefix) => {
            // No outputSchemas -> trigger and step schemas resolve to null.
            const baseConfig: ScopeConfig = {
              steps: [{ slug: "a" }, { slug: "b" }],
              currentStepIndex: 1,
              secretKeys: [],
            };

            // trigger.payload.<suffix> with a null trigger schema yields nothing.
            const triggerPath = ["trigger", "payload", ...suffix];
            expect(getSuggestions(baseConfig, triggerPath, prefix)).toEqual([]);

            // steps.a.result.<suffix> with a null step schema yields nothing.
            const stepPath = ["steps", "a", "result", ...suffix];
            expect(getSuggestions(baseConfig, stepPath, prefix)).toEqual([]);

            // Direct cross-check: the shared walker reports null schemas unresolved.
            const walked = walkSchemaPath(null, suffix);
            expect(walked.resolved).toBe(false);
            expect(walked.children).toEqual([]);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

describe("getOutputSchemaSuggestions metadata", () => {
  // Arbitraries scoped to Property 9. A single property node is generated with an
  // independently-toggled set of declared metadata fields; the suggestion for it
  // must reflect exactly the declared fields, carried verbatim.

  /** Optional declared `type` string, or absent. */
  const typeArb = fc.option(fc.constantFrom(...PRIMITIVE_TYPES), { nil: undefined });

  /** Optional declared `description` string, or absent. */
  const descriptionArb = fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined });

  /** Optional declared `default`, or absent. Includes falsy values on purpose. */
  const defaultArb = fc.option(
    fc.oneof(
      fc.constant(false),
      fc.constant(0),
      fc.constant(""),
      fc.constant(null),
      fc.string(),
      fc.integer(),
      fc.boolean(),
    ),
    { nil: undefined },
  );

  /**
   * Enum declaration variant:
   * - "none": no enum keyword
   * - "direct": a `enum` array of primitive values
   * - "anyOf": the `anyOf`-of-`const` form the schemaForm helpers recognize
   */
  const enumFormArb = fc.oneof(
    fc.constant({ kind: "none" as const }),
    fc
      .array(fc.oneof(fc.string(), fc.integer(), fc.boolean()), { minLength: 1, maxLength: 4 })
      .map((values) => ({ kind: "direct" as const, values })),
    fc
      .array(fc.oneof(fc.string(), fc.integer(), fc.boolean()), { minLength: 1, maxLength: 4 })
      .map((values) => ({ kind: "anyOf" as const, values })),
  );

  test("Feature: workflow-schema-dataflow, Property 9: Metadata fidelity", () => {
    fc.assert(
      fc.property(
        propertyKeyArb,
        typeArb,
        descriptionArb,
        defaultArb,
        enumFormArb,
        fc.boolean(),
        (key, declaredType, declaredDescription, declaredDefault, enumForm, hasDefault) => {
          // Build the child property node from the toggled metadata fields.
          const child: Record<string, unknown> = {};
          if (declaredType !== undefined) child.type = declaredType;
          if (declaredDescription !== undefined) child.description = declaredDescription;
          if (hasDefault) child.default = declaredDefault;

          let expectedEnumValues: string[] | undefined;
          if (enumForm.kind === "direct") {
            child.enum = enumForm.values;
            expectedEnumValues = enumForm.values.map((v) => String(v));
          } else if (enumForm.kind === "anyOf") {
            child.anyOf = enumForm.values.map((v) => ({ const: v }));
            expectedEnumValues = enumForm.values.map((v) => String(v));
          }

          const schema: OutputSchema = {
            type: "object",
            properties: { [key]: child },
          };

          const suggestions = getOutputSchemaSuggestions(schema, [], "");
          expect(suggestions.length).toBe(1);
          const suggestion = suggestions[0] as Suggestion;
          expect(suggestion.label).toBe(key);

          // schemaType present iff `type` string declared; carried verbatim.
          if (declaredType !== undefined) {
            expect(suggestion.schemaType).toBe(declaredType);
          } else {
            expect(suggestion.schemaType).toBeUndefined();
          }

          // description present iff `description` string declared; carried verbatim.
          if (declaredDescription !== undefined) {
            expect(suggestion.description).toBe(declaredDescription);
          } else {
            expect(suggestion.description).toBeUndefined();
          }

          // defaultValue present iff the `default` key is declared (even if falsy);
          // carried verbatim.
          if (hasDefault) {
            expect("defaultValue" in suggestion).toBe(true);
            expect(suggestion.defaultValue).toBe(declaredDefault);
          } else {
            expect(suggestion.defaultValue).toBeUndefined();
          }

          // enumValues present iff an enum is declared; every value included, none extra.
          if (expectedEnumValues !== undefined) {
            expect(suggestion.enumValues).toBeDefined();
            expect(suggestion.enumValues).toEqual(expectedEnumValues);
          } else {
            expect(suggestion.enumValues).toBeUndefined();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
